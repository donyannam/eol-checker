const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Load .env (local secrets, gitignored) without overriding real env vars.
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
} catch {}

// ---------------------------------------------------------------------------
// Configuration (read after .env so the file wins over nothing and loses to
// real environment variables)
// ---------------------------------------------------------------------------

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const list = (value) =>
  String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const app = express();
const PORT = num(process.env.PORT, 3000);
// Bind to loopback by default: a shared or reverse-proxied host must set HOST
// explicitly and put authentication in front of the app.
const HOST = process.env.HOST || "127.0.0.1";
const EOL_API = "https://endoflife.date/api";
const GH_BASE = "https://api.github.com";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_ORG = process.env.GITHUB_ORG || "";
const SCAN_ALLOWED_ORGS = list(process.env.SCAN_ALLOWED_ORGS).map((s) => s.toLowerCase());
const RAW_HOST = process.env.RAW_HOST || "https://raw.githubusercontent.com";

// Coverage knobs. 0 means "no cap"; every cap that bites is reported in the
// scan's `errors` list so results are never dropped silently.
const MAX_REPO_PAGES = num(process.env.MAX_REPO_PAGES, 200);
const MAX_WORKFLOWS_PER_REPO = num(process.env.MAX_WORKFLOWS_PER_REPO, 0);
const MAX_DOCKERFILES_PER_REPO = num(process.env.MAX_DOCKERFILES_PER_REPO, 0);
const MAX_FILES_PER_REPO = num(process.env.MAX_FILES_PER_REPO, 0);
const MAX_FILE_BYTES = num(process.env.MAX_FILE_BYTES, 200000);
const FILE_CONCURRENCY = Math.max(1, num(process.env.FILE_CONCURRENCY, 8));

// Cache lifetimes. endoflife.date data changes daily; failed lookups are cached
// only briefly so a transient outage does not poison the process.
const EOL_CACHE_TTL_MS = num(process.env.EOL_CACHE_TTL_MS, 24 * 60 * 60 * 1000);
const EOL_ERROR_TTL_MS = num(process.env.EOL_ERROR_TTL_MS, 5 * 60 * 1000);
const RUN_CACHE_TTL_MS = num(process.env.RUN_CACHE_TTL_MS, 60 * 60 * 1000);
const CATALOG_CACHE_TTL_MS = num(process.env.CATALOG_CACHE_TTL_MS, 24 * 60 * 60 * 1000);
const JOB_TTL_MS = num(process.env.JOB_TTL_MS, 6 * 60 * 60 * 1000);
const MAX_JOBS = num(process.env.MAX_JOBS, 20);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const toKebab = (s) =>
  String(s)
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/g, "-");
const toStripped = (s) => String(s || "").toLowerCase().replace(/[\s._-]/g, "");

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(map, key, value, ttl) {
  map.set(key, { value, expiresAt: Date.now() + ttl });
  return value;
}

// 1-based line number containing `index`, for regex-based extractors.
function lineOfOffset(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === "\n") line++;
  return line;
}

// Locate the source line a JSON key/value pair came from so every detection can
// cite its evidence (F9).
function jsonLineOf(content, key, value) {
  const lines = content.split("\n");
  const keyNeedle = JSON.stringify(String(key));
  const valNeedle = JSON.stringify(String(value));
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(keyNeedle) && lines[i].includes(valNeedle)) {
      return { line: i + 1, evidence: lines[i].trim() };
    }
  }
  return { line: null, evidence: `${key}@${value}` };
}

// First line of a pin file that actually holds a value (skip blanks/comments).
function pinLineNo(content) {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t && !t.startsWith("#")) return i + 1;
  }
  return 1;
}

const EVIDENCE_MAX = 300;
const evidenceOf = (text) => {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > EVIDENCE_MAX ? `${t.slice(0, EVIDENCE_MAX - 1)}…` : t;
};

// Run `worker` over `items` with bounded concurrency (F7: uncapped candidates
// still cannot flood the GitHub API).
async function pooled(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

class RateLimitError extends Error {}
class AbortedError extends Error {}

// ---------------------------------------------------------------------------
// endoflife.date helpers
// ---------------------------------------------------------------------------

function isEol(cycle, now) {
  const eol = cycle.eol;
  if (typeof eol === "boolean") return eol;
  if (eol == null) return false;
  const d = new Date(eol);
  return Number.isNaN(d.getTime()) ? false : d.getTime() < now;
}

function versionParts(v) {
  return String(v)
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((p) => parseInt(p, 10) || 0);
}

function cmpVersions(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function currentCycle(cycles) {
  const now = Date.now();
  return (
    cycles
      .filter((c) => !isEol(c, now))
      .sort((a, b) => {
        const v = cmpVersions(b.cycle, a.cycle);
        if (v !== 0) return v;
        return new Date(b.latestReleaseDate || 0) - new Date(a.latestReleaseDate || 0);
      })[0] ?? null
  );
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`endoflife.date API error: ${res.status}`);
  return res.json();
}

// Digit-only form of a cycle or product-name suffix. Used only to match a
// suffix the user typed after a product name (e.g. "python310" -> "310" ->
// cycle "3.10"); never used to match a version to a cycle.
const strippedDigits = (v) => String(v).replace(/\D/g, "");

function findCycle(cycles, suffix) {
  if (!suffix) return null;
  const exact = cycles.find((c) => strippedDigits(c.cycle) === suffix);
  if (exact) return exact;
  const candidates = cycles
    .filter((c) => strippedDigits(c.cycle).startsWith(suffix))
    .sort(
      (a, b) =>
        new Date(b.releaseDate || b.latestReleaseDate || 0) -
        new Date(a.releaseDate || a.latestReleaseDate || 0)
    );
  return candidates[0] || null;
}

// ---------------------------------------------------------------------------
// Version -> release cycle matching (F6)
// ---------------------------------------------------------------------------

// Dotted components: "24.15.0" -> [24, 15, 0], "3.10" -> [3, 10],
// "v20" -> [20], "1.25-beta.2" -> [1, 25, 2].
function versionTuple(v) {
  const out = [];
  for (const part of String(v).replace(/^[^\d]*/, "").split(".")) {
    const n = parseInt(part, 10);
    if (Number.isNaN(n)) break;
    out.push(n);
  }
  return out;
}

// Match a concrete version to a release cycle by comparing dotted components.
// The cycle must be a component-wise prefix of the version, and the longest such
// cycle wins: "3.10.4" -> cycle "3.10" when it exists, otherwise "3". This is
// what keeps Go "1.25" off Node cycle "12" and Python "3.1.4" off cycle "3.14".
function findCycleForVersion(cycles, version) {
  const vp = versionTuple(version);
  if (!vp.length) return null;
  let best = null;
  let bestLen = 0;
  for (const c of cycles) {
    const cp = versionTuple(c.cycle);
    if (!cp.length) continue;
    if (cp.length > vp.length || cp.length <= bestLen) continue;
    if (!cp.every((n, i) => n === vp[i])) continue;
    best = c;
    bestLen = cp.length;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Product catalog matching
// ---------------------------------------------------------------------------

// Product-name aliases (stripped form) for common software so manifests like
// "node:18" or ".nvmrc" match a product entered as "nodejs".
const ALIASES = {
  nodejs: ["node"],
  node: ["nodejs"],
  postgresql: ["postgres"],
  python: ["python3"],
  golang: ["go"],
  go: ["golang"],
};

function productVariants(product) {
  const key = toStripped(product);
  const set = new Set([key]);
  for (const [base, aliases] of Object.entries(ALIASES)) {
    if (base === key) for (const a of aliases) set.add(toStripped(a));
  }
  return set;
}

// Find the catalog product whose normalized (stripped) name is a prefix of the
// input. Returns { productId, matchedLength, suffix } with the longest match.
function matchProduct(catalog, wanted) {
  const stripped = toStripped(wanted);
  let best = null;
  for (const p of catalog) {
    const key = toStripped(p);
    if (stripped.startsWith(key) && key.length > 0) {
      if (!best || key.length > best.matchedLength) {
        best = { productId: p, matchedLength: key.length };
      }
    }
  }
  if (!best) return null;
  return { ...best, suffix: stripped.slice(best.matchedLength) };
}

// ---------------------------------------------------------------------------
// GitHub client
// ---------------------------------------------------------------------------

// Credentials: a GitHub App installation token is preferred because it is
// scoped, rotatable and gets a 15,000 req/hr budget instead of 5,000 (F5).
const GH_APP = {
  id: process.env.GITHUB_APP_ID || "",
  installationId: process.env.GITHUB_APP_INSTALLATION_ID || "",
  privateKey: (process.env.GITHUB_APP_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
};
const USE_GITHUB_APP = Boolean(GH_APP.id && GH_APP.installationId && GH_APP.privateKey);
let appToken = null; // { token, expiresAt }
const APP_TOKEN_BUFFER_MS = 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function appJwt() {
  const now = Math.floor(Date.now() / 1000);
  const data = [
    b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: GH_APP.id })),
  ].join(".");
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(data)
    .sign(GH_APP.privateKey)
    .toString("base64url");
  return `${data}.${signature}`;
}

async function githubToken() {
  if (!USE_GITHUB_APP) return GITHUB_TOKEN;
  if (appToken && appToken.expiresAt > Date.now() + APP_TOKEN_BUFFER_MS) return appToken.token;
  const res = await fetch(`${GH_BASE}/app/installations/${encodeURIComponent(GH_APP.installationId)}/access_tokens`, {
    method: "POST",
    headers: {
      "User-Agent": "eol-checker",
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${appJwt()}`,
    },
  });
  if (!res.ok) throw new Error(`GitHub App token request failed: ${res.status}`);
  const json = await res.json();
  appToken = {
    token: json.token,
    expiresAt: json.expires_at
      ? new Date(json.expires_at).getTime()
      : Date.now() + 45 * 60 * 1000,
  };
  return appToken.token;
}

const RATE_LIMIT = { limit: null, remaining: null, reset: null };

async function ghFetch(url) {
  const headers = { "User-Agent": "eol-checker", Accept: "application/vnd.github+json" };
  const token = await githubToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  const limit = res.headers.get("x-ratelimit-limit");
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = res.headers.get("x-ratelimit-reset");
  if (limit != null) {
    RATE_LIMIT.limit = Number(limit);
    RATE_LIMIT.remaining = Number(remaining);
    RATE_LIMIT.reset = Number(reset);
  }

  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) {
    const resetsAt = RATE_LIMIT.reset ? new Date(RATE_LIMIT.reset * 1000).toISOString() : "unknown";
    throw new RateLimitError(
      `GitHub API ${res.status} (rate limit ${remaining}/${limit}, resets ${resetsAt})`
    );
  }
  if (!res.ok) throw new Error(`GitHub API error ${res.status} for ${url}`);
  return res.json();
}

async function ghPaged(url, maxPages = MAX_REPO_PAGES) {
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = url.includes("?") ? "&" : "?";
    const batch = await ghFetch(`${url}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) return { items, truncated: false };
    items.push(...batch);
    if (batch.length < 100) return { items, truncated: false };
  }
  return { items, truncated: true };
}

// Every repository in the org, paging until a short page. The old fixed
// 10-page cap silently hid every repo past the first 1,000 (F2).
async function listOrgRepos(owner) {
  const { items, truncated } = await ghPaged(
    `${GH_BASE}/orgs/${encodeURIComponent(owner)}/repos?type=all&sort=full_name&direction=asc`
  );
  return { repos: items, truncated };
}

// Repo ownership slugs, used to map a repo to a GitHub team and from there to a
// Compass region/category (F10). Only called when domains.json declares teams.
async function listRepoTeamSlugs(owner) {
  const { items: teams, truncated } = await ghPaged(`${GH_BASE}/orgs/${encodeURIComponent(owner)}/teams`);
  const byRepo = new Map();
  const teamNames = [];
  for (const team of teams) {
    const slug = team.slug || toKebab(team.name);
    teamNames.push(slug);
    const { items: repos } = await ghPaged(
      `${GH_BASE}/orgs/${encodeURIComponent(owner)}/teams/${encodeURIComponent(slug)}/repos`
    );
    for (const r of repos) if (r.name && !byRepo.has(r.name)) byRepo.set(r.name, slug);
  }
  return { byRepo, teamNames, truncated };
}

// ---------------------------------------------------------------------------
// Last successful deploy run (F3)
// ---------------------------------------------------------------------------

// "Last deployment" was the newest successful run of *any* workflow, on *any*
// branch, triggered by *anything* (including a scheduled job that fires many
// times a day), read through a `status=success` filter whose result set GitHub
// returns inconsistently for busy repos. Now: no status filter (the filter is
// applied client-side so the result set is complete and stable), limited to the
// default branch and deploy-type triggers, with an explicit reason whenever the
// cell is blank.
const DEPLOY_EVENTS = new Set(["push", "workflow_dispatch", "release", "deployment", "workflow_run"]);
const RUN_PAGE_SIZE = num(process.env.RUN_PAGE_SIZE, 50);
const RUN_MAX_PAGES = Math.max(1, num(process.env.RUN_MAX_PAGES, 3));
const RUN_CACHE = new Map();

// Pick the run that the "Last deploy run" column reports out of one page of
// Actions runs, newest first. Returns { run, stats }; runs outside the scope
// (scheduled jobs, pull-request checks on other branches) are not eligible.
// `stats` accumulates across pages so the final blank-cell reason reflects every
// run that was looked at.
function pickDeployRun(runs, defaultBranch, stats = {}) {
  const s = {
    sawRun: stats.sawRun || false,
    sawSuccess: stats.sawSuccess || false,
    sawSuccessOtherBranch: stats.sawSuccessOtherBranch || false,
    sawSuccessOtherTrigger: stats.sawSuccessOtherTrigger || false,
  };

  for (const run of runs) {
    s.sawRun = true;
    if (run.conclusion !== "success") continue;
    s.sawSuccess = true;
    const onDefault = !run.head_branch || run.head_branch === defaultBranch;
    if (!onDefault) {
      s.sawSuccessOtherBranch = true;
      continue;
    }
    if (!DEPLOY_EVENTS.has(run.event)) {
      s.sawSuccessOtherTrigger = true;
      continue;
    }
    return { run, stats: s };
  }
  return { run: null, stats: s };
}

function deployRunReason(stats, defaultBranch, scannedRuns) {
  if (!stats.sawRun) return "No workflow runs";
  if (!stats.sawSuccess) return "No successful run";
  if (stats.sawSuccessOtherBranch && !stats.sawSuccessOtherTrigger) {
    return `No successful run on ${defaultBranch}`;
  }
  if (stats.sawSuccessOtherTrigger) {
    return `No deploy-type run on ${defaultBranch} in the last ${scannedRuns} runs`;
  }
  return `No successful run on ${defaultBranch}`;
}

async function getLastSuccessfulRun(owner, repo, defaultBranch) {
  const key = `${owner}/${repo}`;
  const cached = cacheGet(RUN_CACHE, key);
  if (cached) return cached;

  const scope =
    "newest successful run on the default branch with a push/workflow_dispatch/release trigger";
  let result;
  try {
    let picked = null;
    let stats = {};
    let scannedRuns = 0;

    for (let page = 1; page <= RUN_MAX_PAGES && !picked; page++) {
      const data = await ghFetch(
        `${GH_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
          repo
        )}/actions/runs?per_page=${RUN_PAGE_SIZE}&page=${page}`
      );
      if (data === null) {
        result = {
          date: null,
          name: null,
          url: null,
          branch: null,
          reason: "Actions data unavailable (repo or token)",
          scope,
        };
        return cacheSet(RUN_CACHE, key, result, RUN_CACHE_TTL_MS);
      }
      const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
      scannedRuns += runs.length;
      const page1 = pickDeployRun(runs, defaultBranch, stats);
      stats = page1.stats;
      if (page1.run) picked = page1.run;
    }

    if (picked) {
      result = {
        date: picked.updated_at || picked.run_started_at || picked.created_at || null,
        name: picked.name || null,
        url: picked.html_url || null,
        branch: picked.head_branch || null,
        event: picked.event || null,
        reason: null,
        scope,
      };
    } else {
      result = {
        date: null,
        name: null,
        url: null,
        branch: null,
        reason: deployRunReason(stats, defaultBranch, scannedRuns),
        scope,
      };
    }
  } catch (err) {
    result = { date: null, name: null, url: null, branch: null, reason: err.message, scope };
  }

  return cacheSet(RUN_CACHE, key, result, RUN_CACHE_TTL_MS);
}

// ---------------------------------------------------------------------------
// Repo tree and raw file contents
// ---------------------------------------------------------------------------

async function getRepoTree(owner, repo, branch) {
  if (!branch) return { files: [], truncated: false, reason: "Repo has no default branch" };
  const data = await ghFetch(
    `${GH_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo
    )}/git/trees/${encodeURIComponent(branch)}?recursive=1`
  );
  if (data === null) return { files: [], truncated: false, reason: `Default branch ${branch} not found` };
  const files = Array.isArray(data.tree) ? data.tree.filter((t) => t.type === "blob") : [];
  // A truncated tree silently hides whole subtrees, so it is reported as an
  // incomplete scan rather than a complete one (F7).
  return {
    files,
    truncated: Boolean(data.truncated),
    reason: data.truncated
      ? `GitHub returned a truncated file tree; files under some directories were not listed`
      : null,
  };
}

async function fetchRawFile(owner, repo, branch, filePath) {
  const url = `${RAW_HOST}/${owner}/${repo}/${branch}/${filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const headers = { "User-Agent": "eol-checker" };
  const token = await githubToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    return { text: "", reason: `fetch failed: ${err.message}` };
  }
  if (res.status === 404) return { text: "", reason: "HTTP 404" };
  if (res.status === 403 || res.status === 429) {
    return { text: "", reason: `HTTP ${res.status} (rate limit or no contents access)` };
  }
  if (!res.ok) return { text: "", reason: `HTTP ${res.status}` };
  const text = await res.text();
  if (text.length > MAX_FILE_BYTES) {
    return { text: "", reason: `File larger than ${MAX_FILE_BYTES} bytes` };
  }
  return { text, reason: null };
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

function classifyFile(file) {
  const parts = file.split("/");
  const base = parts[parts.length - 1].toLowerCase();
  if (base === ".nvmrc" || base === ".node-version") return "pin-node";
  if (base === ".python-version") return "pin-python";
  if (base === ".ruby-version") return "pin-ruby";
  if (base === ".terraform-version") return "pin-terraform";
  if (base === ".tool-versions" || base === ".mise.toml" || base === "mise.toml")
    return "tool-versions";
  if (base === "package.json") return "package-json";
  if (base === "composer.json") return "composer-json";
  if (base === "pipfile" || base === "pipfile.lock") return "pipfile";
  if (base === "pyproject.toml") return "pyproject";
  if (base === "gemfile" || base === "gemfile.lock") return "gemfile";
  if (base === "go.mod") return "go-mod";
  if (base === "pom.xml") return "pom";
  if (base === "build.gradle" || base === "build.gradle.kts") return "gradle";
  if (/^requirements[-_.]?.*\.txt$/.test(base) || base === "requirements.txt")
    return "requirements";
  if (base.startsWith("dockerfile") || base.endsWith(".dockerfile")) return "docker";
  if (
    (base.startsWith("docker-compose") || base.startsWith("compose")) &&
    (base.endsWith(".yml") || base.endsWith(".yaml"))
  )
    return "compose";
  if (
    (parts.includes(".github") && parts[parts.length - 2] === "workflows") ||
    base === ".gitlab-ci.yml" ||
    base === ".gitlab-ci.yaml" ||
    base === "azure-pipelines.yml" ||
    base === "azure-pipelines.yaml"
  ) {
    // Only real YAML is a workflow: repos keep .txt/.md scratch files and
    // notes next to their workflows, and those were parsed as workflows (F7).
    return base.endsWith(".yml") || base.endsWith(".yaml") ? "workflow" : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Version detection
// ---------------------------------------------------------------------------

function normVersion(raw) {
  const m = String(raw).match(/\d+(\.\d+)*/);
  return m ? m[0] : null;
}

// A spec is a constraint, not the version in use, when it carries a range
// operator: caret, tilde, comparator, wildcard, union or hyphen range. F4:
// ">=8.0.0" and "^16 || ^18 || ^20 || >=22" describe what a package *accepts*,
// not what runs.
function isConstraintSpec(spec) {
  const s = String(spec).trim();
  if (!s) return true;
  if (/[*xX]/.test(s)) return true;
  if (/[<>=~^]/.test(s)) return true;
  if (/\|\|/.test(s)) return true;
  if (/\s-\s/.test(s)) return true;
  if (/\b(?:or|and)\b/i.test(s)) return true;
  return false;
}

function splitImage(img) {
  let base = img.split("/").pop();
  const at = base.indexOf("@");
  if (at > -1) base = base.slice(0, at);
  const [name, tag] = base.split(":");
  return [name, tag];
}

function hostOf(value) {
  if (!value) return "";
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Which product a `actions/setup-*` step configures, and which manifest names
// that product can appear under. A setup step only contributes a version when
// the product being scanned is the one that step installs, which is what stops
// `setup-dotnet 8.0.x` from being reported as Node 8 (F1).
const SETUP_LANG = {
  node: "node",
  python: "python",
  go: "golang",
  java: "java",
  ruby: "ruby",
  dotnet: "dotnet",
  php: "php",
};
const SETUP_PRODUCTS = {
  node: ["node", "nodejs"],
  python: ["python", "python3"],
  golang: ["go", "golang"],
  java: ["java"],
  ruby: ["ruby"],
  dotnet: ["dotnet"],
  php: ["php"],
};
const SETUP_INPUT = {
  node: "node-version",
  python: "python-version",
  golang: "go-version",
  java: "java-version",
  ruby: "ruby-version",
  dotnet: "dotnet-version",
  php: "php-version",
};

// Detect versions of the requested product inside a file's content.
// Every detection carries { version, spec, raw, line, constraint, detectedAs },
// where detectedAs is the name the manifest itself used ("node", "nodejs",
// "node-version", "node" in a FROM line) - the requested product is often an
// alias of it, and the export needs to show both.
function detectInFile(type, content, variants) {
  const out = [];
  const add = (spec, line, evidence, detectedAs) => {
    const version = normVersion(spec);
    if (!version) return;
    out.push({
      version,
      spec: String(spec).trim(),
      raw: evidenceOf(evidence != null ? evidence : spec),
      line: line ?? null,
      constraint: isConstraintSpec(spec),
      detectedAs: detectedAs || null,
    });
  };

// A pin file declares exactly one version for exactly one tool.
  const pinTarget = {
    "pin-node": "node",
    "pin-python": "python",
    "pin-ruby": "ruby",
    "pin-terraform": "terraform",
  }[type];
  if (pinTarget) {
    if (variants.has(pinTarget)) add(content, pinLineNo(content), content, pinTarget);
    return out;
  }

  if (type === "tool-versions") {
    content.split("\n").forEach((line, i) => {
      const t = line.trim();
      const m = t.match(/^([^\s]+)(\s+)(v?\d[\w.-]*)/);
      if (m && variants.has(toStripped(m[1]))) add(m[3], i + 1, t, m[1]);
    });
    return out;
  }

  if (type === "package-json" || type === "composer-json") {
    const sections =
      type === "package-json"
        ? ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "engines"]
        : ["require", "require-dev"];
    try {
      const j = JSON.parse(content);
      for (const key of sections) {
        const sec = j[key];
        if (!sec || typeof sec !== "object") continue;
        for (const [name, ver] of Object.entries(sec)) {
          if (typeof ver !== "string" || !variants.has(toStripped(name))) continue;
          const at = jsonLineOf(content, name, ver);
          add(ver, at.line, at.evidence, name);
        }
      }
    } catch {}
    return out;
  }

  if (type === "requirements") {
    content.split("\n").forEach((line, i) => {
      const t = line.replace(/\s*#.*$/, "").trim();
      const m = t.match(/^([A-Za-z0-9_.\-]+)\s*([<>=!~]+)\s*(\S+)/);
      if (m && variants.has(toStripped(m[1]))) add(m[3], i + 1, t, m[1]);
    });
    return out;
  }

  if (type === "pipfile" || type === "pyproject") {
    content.split("\n").forEach((line, i) => {
      let m = line.match(/^\s*([\w.-]+)\s*=\s*["']([^"']+)["']/);
      if (m && variants.has(toStripped(m[1]))) add(m[2], i + 1, line.trim(), m[1]);
      m = line.match(/["']([\w.-]+)(?:==|>=|<=|~=|<|>|=)\s*([\d][^"']*)["']/);
      if (m && variants.has(toStripped(m[1]))) add(m[2], i + 1, line.trim(), m[1]);
    });
    return out;
  }

  if (type === "gemfile") {
    content.split("\n").forEach((line, i) => {
      const m = line.match(/^\s*gem\s+["']([^"']+)["']\s*,\s*["']([^"']+)["']/);
      if (m && variants.has(toStripped(m[1]))) add(m[2], i + 1, line.trim(), m[1]);
    });
    return out;
  }

  if (type === "go-mod") {
    content.split("\n").forEach((line, i) => {
      const t = line.trim();
      const m = t.match(/^([a-zA-Z0-9_.\-/]+)\s+(v?\d[\w.-]+)/);
      if (m) {
        const name = m[1].split("/").pop();
        if (variants.has(toStripped(name))) add(m[2], i + 1, t, m[1]);
      }
    });
    return out;
  }

  if (type === "pom") {
    const re = /<artifactId>\s*([^<]+)<\/artifactId>[\s\S]*?<version>\s*([^<]+)<\/version>/g;
    let m;
    while ((m = re.exec(content))) {
      if (!variants.has(toStripped(m[1]))) continue;
      add(m[2], lineOfOffset(content, m.index), content.slice(m.index, m.index + 160), m[1]);
    }
    return out;
  }

  if (type === "gradle") {
    const re = /["']([\w.-]+)(?::([\w.-]+))?[:@](v?\d[\w.\-]+(?:-[^"']*)?)["']/g;
    let m;
    while ((m = re.exec(content))) {
      const name = m[2] || m[1];
      if (!variants.has(toStripped(name))) continue;
      add(m[3], lineOfOffset(content, m.index), m[0], name);
    }
    return out;
  }

  if (type === "docker" || type === "compose" || type === "workflow") {
    content.split("\n").forEach((line, i) => {
      const from = line.match(/^\s*FROM\s+(\S+)/i);
      const image = line.match(/^\s*image:\s*(\S+)/i);
      const container = line.match(/^\s*(?:container|post)\s*:\s*(\S+)/i);
      const spec = (from && from[1]) || (image && image[1]) || (container && container[1]);
      if (!spec) return;
      const [name, tag] = splitImage(spec);
      if (tag && variants.has(toStripped(name))) add(tag, i + 1, spec, name);
    });
  }

  if (type === "workflow") {
    let pending = null;
    content.split("\n").forEach((line, i) => {
      const t = line.trim();
      if (/^-\s/.test(t) && !/^-\s*name\s*:/i.test(t)) pending = null;
      const uses = t.match(/uses:\s*([^\s]+)/i);
      if (uses && uses[1].toLowerCase().includes("/setup-")) {
        const m = uses[1].match(/setup-([a-z0-9-]+)/i);
        const lang = m && m[1].toLowerCase();
        const setup = lang ? SETUP_LANG[lang] : null;
        const names = setup ? SETUP_PRODUCTS[setup] || [] : [];
        // Only arm the input matcher when the product being scanned is the one
        // this setup step installs, and always disarm otherwise (F1).
        pending = names.some((n) => variants.has(n)) ? setup : null;
        return;
      }
      if (pending) {
        const input = new RegExp(`^${SETUP_INPUT[pending]}\\s*:\\s*["']?([^\\s#'"]+)`, "i");
        const m = t.match(input);
        if (m) {
          add(m[1], i + 1, t, SETUP_INPUT[pending]);
          pending = null;
        }
      }
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Functional domain mapping (F10)
// ---------------------------------------------------------------------------

// domains.json holds exact repo-name overrides and a team-slug -> Compass
// taxonomy table. Substring rules are gone: they matched the org prefix and
// mid-word fragments ("edi" in "credit", "load" in "upload"), which misfiled
// repos and still left 54 of 119 unmapped. Unmapped repos say so.
const DOMAIN_RULES = (() => {
  const raw = require(path.join(__dirname, "domains.json"));
  const pick = (value) => {
    if (typeof value === "string") return { region: "", category: value };
    return { region: value?.region || "", category: value?.category || "" };
  };
  const repos = {};
  for (const [key, value] of Object.entries(raw.repos || {})) {
    if (key.startsWith("_")) continue;
    repos[key.toLowerCase()] = pick(value);
  }
  const teams = {};
  for (const [key, value] of Object.entries(raw.teams || {})) {
    if (key.startsWith("_")) continue;
    teams[toKebab(key)] = pick(value);
  }
  return { repos, teams, teamCount: Object.keys(teams).length };
})();

const UNMAPPED = "Unmapped";

// Resolve a repo to { domain, region, domainSource }. Repo overrides win over
// the owning team's taxonomy; anything else is explicitly Unmapped.
function functionalDomain(repo, teamSlugs) {
  const name = String(repo.name || "").toLowerCase();
  const byRepo = DOMAIN_RULES.repos[name];
  if (byRepo && byRepo.category) {
    return { domain: byRepo.category, region: byRepo.region, domainSource: "repo-override" };
  }
  const slug = teamSlugs?.get ? teamSlugs.get(name) : null;
  const byTeam = slug ? DOMAIN_RULES.teams[slug] : null;
  if (byTeam && byTeam.category) {
    return { domain: byTeam.category, region: byTeam.region, domainSource: `team:${slug}` };
  }
  return { domain: UNMAPPED, region: "", domainSource: null };
}

// ---------------------------------------------------------------------------
// EOL resolution
// ---------------------------------------------------------------------------

const EOL_CACHE = new Map();
const CATALOG_CACHE = new Map();

function eolSourceUrl(productId) {
  return productId ? `${EOL_API}/${productId}.json` : null;
}

async function getCatalog() {
  const cached = cacheGet(CATALOG_CACHE, "all");
  if (cached) return cached;
  const catalog = await fetchJson(`${EOL_API}/all.json`);
  return cacheSet(CATALOG_CACHE, "all", Array.isArray(catalog) ? catalog : [], CATALOG_CACHE_TTL_MS);
}

// Resolve the EOL status for a product/version using endoflife.date.
async function lookupProductEol(product, version, catalog) {
  const cacheKey = `${toKebab(product)}|${version}`;
  const cached = cacheGet(EOL_CACHE, cacheKey);
  if (cached) return cached;

  const match = matchProduct(catalog, product);
  const productId = (match && match.productId) || toKebab(product);

  let cycles = null;
  let failure = null;
  try {
    cycles = await fetchJson(`${EOL_API}/${productId}.json`);
  } catch (err) {
    failure = err.message;
  }
  if (!cycles && match) {
    try {
      cycles = await fetchJson(`${EOL_API}/${match.productId}.json`);
    } catch (err) {
      failure = err.message;
    }
  }

  if (!Array.isArray(cycles)) {
    // Failures and unknown products are cached only briefly (F5): caching them
    // for a day made a transient outage look like a permanent answer.
    return cacheSet(
      EOL_CACHE,
      cacheKey,
      {
        status: "error",
        productId,
        sourceUrl: eolSourceUrl(productId),
        cycle: null,
        latest: null,
        latestReleaseDate: null,
        eol: null,
        support: null,
        isLts: false,
        error: failure || `No EOL data found for "${product}".`,
      },
      EOL_ERROR_TTL_MS
    );
  }

  const now = Date.now();
  const cycle = findCycleForVersion(cycles, version);

  let status;
  if (!cycle) status = "unknown";
  else if (isEol(cycle, now)) status = "eol";
  else if (typeof cycle.support === "string" && new Date(cycle.support).getTime() < now)
    status = "warning";
  else status = "active";

  return cacheSet(
    EOL_CACHE,
    cacheKey,
    {
      status,
      productId,
      sourceUrl: eolSourceUrl(productId),
      cycle: cycle?.cycle ?? null,
      latest: cycle?.latest ?? null,
      latestReleaseDate: cycle?.latestReleaseDate || null,
      eol: cycle?.eol ?? null,
      support: cycle?.support ?? null,
      isLts: typeof cycle?.lts === "string" || cycle?.lts === true,
    },
    EOL_CACHE_TTL_MS
  );
}

// ---------------------------------------------------------------------------
// Org scan
// ---------------------------------------------------------------------------

const STATUS_RANK = { active: 1, unknown: 0, warning: 2, eol: 3 };

// Repo-level rollup (F11): decisions are made per repo, not per row.
function rollupByRepo(rows) {
  const byRepo = new Map();
  for (const r of rows) {
    let entry = byRepo.get(r.repo);
    if (!entry) {
      entry = {
        repo: r.repo,
        repoUrl: r.repoUrl,
        domain: r.domain,
        region: r.region,
        rows: 0,
        pinnedRows: 0,
        constraintRows: 0,
        eolRows: 0,
        worst: "active",
        constraintsOnly: true,
      };
      byRepo.set(r.repo, entry);
    }
    entry.rows += 1;
    if (r.detection === "constraint") entry.constraintRows += 1;
    else entry.pinnedRows += 1;
    if (r.detection !== "constraint" && r.eol.status === "eol") entry.eolRows += 1;
    if (r.detection === "constraint") continue;
    entry.constraintsOnly = false;
    if ((STATUS_RANK[r.eol.status] ?? 0) > (STATUS_RANK[entry.worst] ?? 0)) entry.worst = r.eol.status;
  }
  return [...byRepo.values()];
}

// Stamp every row with its repository's worst status, so a per-row export can
// still answer "which repos are EOL?" without re-reading the file (F11).
function stampRepoStatus(rows) {
  for (const entry of rollupByRepo(rows)) {
    const status = entry.constraintsOnly ? "constraintsOnly" : entry.worst;
    for (const r of rows) {
      if (r.repo === entry.repo) r.repoStatus = status;
    }
  }
  return rows;
}

function buildSummary(scan) {
  const repos = rollupByRepo(scan.rows);
  const reposByStatus = { eol: 0, warning: 0, active: 0, unknown: 0, constraintsOnly: 0 };
  const reposByDomain = {};
  for (const r of repos) {
    if (r.constraintsOnly) reposByStatus.constraintsOnly += 1;
    else reposByStatus[r.worst] += 1;
    const key = r.domain || UNMAPPED;
    if (!reposByDomain[key]) reposByDomain[key] = { domain: key, repos: 0, eol: 0 };
    reposByDomain[key].repos += 1;
    if (r.eolRows) reposByDomain[key].eol += 1;
  }
  const pinned = scan.rows.filter((r) => r.detection !== "constraint");
  return {
    scannedRepos: scan.scannedRepos,
    listedRepos: scan.listedRepos,
    forkRepos: scan.forkRepos,
    archivedRepos: scan.archivedRepos,
    listingTruncated: scan.listingTruncated,
    reposWithMatches: repos.length,
    rows: scan.rows.length,
    pinnedRows: pinned.length,
    constraintRows: scan.rows.length - pinned.length,
    reposByStatus,
    reposByDomain: Object.values(reposByDomain).sort((a, b) => b.repos - a.repos),
    coverage: {
      truncatedTrees: scan.truncatedTrees,
      failedFetches: scan.failedFetches,
      skippedFiles: scan.skippedFiles,
    },
  };
}

// Pick the manifest files to read for one repo, recording every file that a cap
// or a failed fetch keeps out of the scan (F7).
function selectCandidates(files) {
  const candidates = [];
  const skipped = [];
  let workflows = 0;
  let dockers = 0;

  for (const f of files) {
    const type = classifyFile(f.path);
    if (!type) continue;
    if (type === "workflow") {
      workflows += 1;
      if (MAX_WORKFLOWS_PER_REPO && workflows > MAX_WORKFLOWS_PER_REPO) {
        skipped.push(f.path);
        continue;
      }
    } else if (type === "docker") {
      dockers += 1;
      if (MAX_DOCKERFILES_PER_REPO && dockers > MAX_DOCKERFILES_PER_REPO) {
        skipped.push(f.path);
        continue;
      }
    } else if (MAX_FILES_PER_REPO && candidates.length >= MAX_FILES_PER_REPO) {
      skipped.push(f.path);
      continue;
    }
    candidates.push({ type, path: f.path });
  }
  return { candidates, skipped };
}

async function scanOrg(owner, products, options = {}) {
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 0;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const errors = [];

  onProgress({ phase: "catalog" });
  const catalog = await getCatalog();

  onProgress({ phase: "listing" });
  const { repos: listed, truncated: listingTruncated } = await listOrgRepos(owner);
  if (listingTruncated) {
    throw new Error(
      `Repository listing stopped at ${MAX_REPO_PAGES} pages; raise MAX_REPO_PAGES to cover the whole org.`
    );
  }

  const forkRepos = listed.filter((r) => r.fork).length;
  const scannable = listed.filter((r) => !r.fork && !r.archived);
  const archivedRepos = listed.length - forkRepos - scannable.length;
  // `limit` applies to repositories actually scanned, after forks and archived
  // repos are removed (F2).
  const repos = limit ? scannable.slice(0, limit) : scannable;

  let teamSlugs = null;
  if (DOMAIN_RULES.teamCount > 0) {
    onProgress({ phase: "teams" });
    try {
      teamSlugs = (await listRepoTeamSlugs(owner)).byRepo;
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      // Team lookup is best-effort: repos without a mapped team fall through
      // to the override table and are then reported as Unmapped.
      errors.push({ repo: `${owner}/*`, message: `Team lookup failed: ${err.message}` });
    }
  }

  const rows = [];
  let scannedRepos = 0;
  let truncatedTrees = 0;
  let failedFetches = 0;
  let skippedFiles = 0;

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    onProgress({
      phase: "scanning",
      repo: repo.full_name,
      repoIndex: i + 1,
      repos: repos.length,
      matches: rows.length,
    });

    try {
      scannedRepos += 1;
      const branch = repo.default_branch;

      const tree = await getRepoTree(owner, repo.name, branch);
      if (tree.reason) errors.push({ repo: repo.full_name, message: tree.reason });
      if (tree.truncated) truncatedTrees += 1;
      if (!tree.files.length) continue;

      const lastDeployment = await getLastSuccessfulRun(owner, repo.name, branch);
      const mapping = functionalDomain(repo, teamSlugs);

      const { candidates, skipped } = selectCandidates(tree.files);
      if (skipped.length) {
        skippedFiles += skipped.length;
        errors.push({
          repo: repo.full_name,
          message: `Skipped ${skipped.length} manifest file(s) due to per-repo caps: ${skipped
            .slice(0, 10)
            .join(", ")}${skipped.length > 10 ? ", …" : ""}`,
        });
      }

      const fetched = await pooled(candidates, FILE_CONCURRENCY, async (c) => {
        const result = await fetchRawFile(owner, repo.name, branch, c.path);
        return result.text ? { type: c.type, path: c.path, text: result.text } : { path: c.path, reason: result.reason };
      });
      for (const f of fetched) {
        if (f.text) continue;
        failedFetches += 1;
        errors.push({ repo: repo.full_name, message: `Could not read ${f.path}: ${f.reason}` });
      }
      const contents = fetched.filter((f) => f.text);

      for (const p of products) {
        const rawName = typeof p === "string" ? p : p?.name;
        const displayName = typeof p === "string" ? rawName : p?.label || rawName;
        const variants = productVariants(rawName);

        for (const c of contents) {
          for (const d of detectInFile(c.type, c.text, variants)) {
            const eol = await lookupProductEol(rawName, d.version, catalog);
            rows.push({
              repo: repo.full_name,
              repoUrl: repo.html_url,
              domain: mapping.domain,
              region: mapping.region,
              domainHost: hostOf(repo.homepage),
              domainSource: mapping.domainSource,
              branch,
              lastDeployment,
              name: displayName,
              file: c.path,
              line: d.line,
              version: d.version,
              versionRaw: d.raw,
              versionSpec: d.spec,
              detectedAs: d.detectedAs,
              detection: d.constraint ? "constraint" : "pinned",
              confidence: d.constraint ? "Medium" : "High",
              eol,
            });
          }
        }
      }
    } catch (err) {
      if (err instanceof RateLimitError || err instanceof AbortedError) {
        errors.push({ repo: repo.full_name, message: err.message });
        break;
      }
      errors.push({ repo: repo.full_name, message: err.message });
    }
  }

  const scan = {
    owner,
    products,
    scannedRepos,
    listedRepos: listed.length,
    forkRepos,
    archivedRepos,
    listingTruncated,
    reposRequested: limit || null,
    rows: stampRepoStatus(rows),
    errors,
    truncatedTrees,
    failedFetches,
    skippedFiles,
  };
  return { ...scan, summary: buildSummary(scan) };
}

// ---------------------------------------------------------------------------
// Background scan jobs (F5)
// ---------------------------------------------------------------------------

// A full-org scan is thousands of sequential API calls and routinely outruns a
// reverse proxy's 60s response timeout, so a scan is a job: start it, poll its
// progress, read the stored result. Storing results with a timestamp is also
// what scheduled runs and history build on.
const SCAN_JOBS = new Map();

function pruneJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of SCAN_JOBS) {
    if (new Date(job.createdAt).getTime() < cutoff) SCAN_JOBS.delete(id);
  }
  while (SCAN_JOBS.size > MAX_JOBS) {
    SCAN_JOBS.delete(SCAN_JOBS.keys().next().value);
  }
}

function jobSummary(job) {
  return {
    jobId: job.id,
    owner: job.owner,
    products: job.products,
    limit: job.limit,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress,
    error: job.error,
  };
}

function createScanJob(owner, products, limit) {
  pruneJobs();
  const key = `${owner}|${limit || ""}|${JSON.stringify(products)}`;
  for (const job of SCAN_JOBS.values()) {
    if (job.key === key && (job.status === "queued" || job.status === "running")) return job;
  }

  const job = {
    id: `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
    key,
    owner,
    products,
    limit: limit || null,
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    progress: null,
    result: null,
    error: null,
  };
  SCAN_JOBS.set(job.id, job);
  pruneJobs();

  // Deliberately not awaited: the HTTP response returns the job id immediately.
  setImmediate(async () => {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    try {
      job.result = await scanOrg(owner, products, {
        limit,
        onProgress: (p) => {
          job.progress = { ...p, at: new Date().toISOString() };
        },
      });
      job.status = "done";
    } catch (err) {
      job.status = "failed";
      job.error = err.message;
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  });

  return job;
}

function allowedOrgs() {
  const orgs = [GITHUB_ORG, ...SCAN_ALLOWED_ORGS].filter(Boolean);
  return [...new Set(orgs.map((o) => o.toLowerCase()))];
}

function orgAllowed(owner) {
  const allowed = allowedOrgs();
  // With nothing configured (local dev) leave the field open; with an org or an
  // allow-list configured, a caller cannot scan anything else (F5).
  if (!allowed.length) return true;
  return allowed.includes(String(owner).toLowerCase());
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

app.get("/api/org", (_req, res) => {
  res.json({
    org: GITHUB_ORG,
    allowedOrgs: allowedOrgs(),
    credentials: USE_GITHUB_APP ? "github-app" : GITHUB_TOKEN ? "pat" : "none",
    limits: {
      maxWorkflowsPerRepo: MAX_WORKFLOWS_PER_REPO || null,
      maxDockerfilesPerRepo: MAX_DOCKERFILES_PER_REPO || null,
      maxFilesPerRepo: MAX_FILES_PER_REPO || null,
      maxFileBytes: MAX_FILE_BYTES,
    },
  });
});

app.get("/api/products", async (_req, res) => {
  try {
    res.json(await getCatalog());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/eol", async (req, res) => {
  const { products } = req.body || {};
  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: "Provide a non-empty 'products' array." });
  }

  let catalog;
  try {
    catalog = await getCatalog();
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  const now = Date.now();
  const results = [];

  for (const entry of products) {
    const rawName = typeof entry === "string" ? entry : entry?.name;
    const displayName = typeof entry === "string" ? rawName : entry?.label || rawName;

    const requestedId = typeof entry === "string" ? null : entry?.productId;
    const productId = requestedId || toKebab(rawName);
    const match = matchProduct(catalog, rawName);
    let targetedSuffix = "";
    let cycles;
    let targetedCycle = null;

    try {
      cycles = await fetchJson(`${EOL_API}/${productId}.json`);
      if (!cycles && match) {
        cycles = await fetchJson(`${EOL_API}/${match.productId}.json`);
        if (Array.isArray(cycles)) {
          targetedSuffix = match.suffix || "";
          targetedCycle = findCycle(cycles, targetedSuffix);
        }
      }
    } catch (err) {
      results.push({ name: displayName, requested: rawName, error: err.message });
      continue;
    }

    if (!cycles || !Array.isArray(cycles)) {
      results.push({
        name: displayName,
        requested: rawName,
        error: `No EOL data found for "${rawName}".`,
      });
      continue;
    }

    const cycle = targetedCycle || currentCycle(cycles);

    results.push({
      name: displayName,
      requested: rawName,
      productId: targetedCycle ? match.productId : productId,
      sourceUrl: eolSourceUrl(targetedCycle ? match.productId : productId),
      cycles: cycles.length,
      status: cycle ? "active" : "all-eol",
      targetedCycle: targetedCycle ? cycle.cycle : null,
      current: cycle
        ? {
            releaseCycle: cycle.cycle,
            latest: cycle.latest || null,
            latestReleaseDate: cycle.latestReleaseDate || null,
            eol: cycle.eol ?? null,
            support: cycle.support ?? null,
            isLts: typeof cycle.lts === "string" || cycle.lts === true,
          }
        : null,
      checkedAt: new Date(now).toISOString(),
    });
  }

  res.json({ results });
});

app.post("/api/org-scan", (req, res) => {
  const { owner, products, limit } = req.body || {};
  if (!owner || typeof owner !== "string") {
    return res.status(400).json({ error: "Provide an 'owner' (GitHub org name)." });
  }
  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: "Provide a non-empty 'products' array." });
  }
  if (!orgAllowed(owner)) {
    return res.status(403).json({
      error: `Scanning "${owner}" is not allowed. Configured: ${allowedOrgs().join(", ") || "none"}.`,
    });
  }

  getCatalog().catch(() => {}); // warm the catalog while the job starts

  const job = createScanJob(owner, products, Number(limit) > 0 ? Number(limit) : 0);
  res.status(202).json(jobSummary(job));
});

app.get("/api/org-scan/jobs", (_req, res) => {
  pruneJobs();
  res.json({ jobs: [...SCAN_JOBS.values()].reverse().map(jobSummary) });
});

app.get("/api/org-scan/jobs/:id", (req, res) => {
  const job = SCAN_JOBS.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Unknown or expired scan job." });
  res.json({ ...jobSummary(job), result: job.result });
});

app.get("/api/org-scan/latest", (req, res) => {
  const owner = String(req.query.owner || "").toLowerCase();
  if (!orgAllowed(owner || GITHUB_ORG)) {
    return res.status(403).json({ error: "Not allowed for this org." });
  }
  pruneJobs();
  const done = [...SCAN_JOBS.values()]
    .filter((j) => j.status === "done" && (!owner || j.owner.toLowerCase() === owner))
    .sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt));
  if (!done.length) return res.status(404).json({ error: "No completed scan stored yet." });
  res.json({ ...jobSummary(done[0]), result: done[0].result });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, rateLimit: RATE_LIMIT, jobs: SCAN_JOBS.size });
});

app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));

module.exports = {
  app,
  // Pure helpers, exported for tests.
  detectInFile,
  classifyFile,
  normVersion,
  isConstraintSpec,
  versionTuple,
  findCycleForVersion,
  findCycle,
  matchProduct,
  productVariants,
  pickDeployRun,
  deployRunReason,
  functionalDomain,
  rollupByRepo,
  buildSummary,
  scanOrg,
  selectCandidates,
  listOrgRepos,
  listRepoTeamSlugs,
  domainRules: DOMAIN_RULES,
  UNMAPPED,
};

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`EOL checker running at http://${HOST}:${PORT}`);
    console.log(
      `Credentials: ${USE_GITHUB_APP ? "GitHub App installation token" : GITHUB_TOKEN ? "GITHUB_TOKEN (PAT)" : "none (public data only)"}`
    );
    if (!allowedOrgs().length) {
      console.warn("Warning: GITHUB_ORG/SCAN_ALLOWED_ORGS unset — any org the token can read may be scanned.");
    }
  });
}