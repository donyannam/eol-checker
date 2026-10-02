const express = require("express");
const path = require("path");
const fs = require("fs");

// Load .env (local secrets, gitignored) without overriding real env vars.
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
} catch {}

const app = express();
const PORT = process.env.PORT || 3000;
const EOL_API = "https://endoflife.date/api";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_ORG = process.env.GITHUB_ORG || "";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const toKebab = (s) =>
  String(s)
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/g, "-");
const toStripped = (s) => String(s || "").toLowerCase().replace(/[\s._-]/g, "");

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
  return cycles
    .filter((c) => !isEol(c, now))
    .sort((a, b) => {
      const v = cmpVersions(b.cycle, a.cycle);
      if (v !== 0) return v;
      return new Date(b.latestReleaseDate || 0) - new Date(a.latestReleaseDate || 0);
    })[0] ?? null;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`endoflife.date API error: ${res.status}`);
  return res.json();
}

function cycleKey(cycle) {
  return String(cycle).replace(/\D/g, "");
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
  return {
    ...best,
    suffix: stripped.slice(best.matchedLength),
  };
}

function findCycle(cycles, suffix) {
  if (!suffix) return null;
  const exact = cycles.find((c) => cycleKey(c.cycle) === suffix);
  if (exact) return exact;
  const candidates = cycles
    .filter((c) => cycleKey(c.cycle).startsWith(suffix))
    .sort(
      (a, b) =>
        new Date(b.releaseDate || b.latestReleaseDate || 0) -
        new Date(a.releaseDate || a.latestReleaseDate || 0)
    );
  return candidates[0] || null;
}

// Match a concrete version (e.g. "24.15" or "18") to its release cycle, where
// the cycle key is a prefix of the version key.
function findCycleForVersion(cycles, versionKey) {
  if (!versionKey) return null;
  const exact = cycles.find((c) => cycleKey(c.cycle) === versionKey);
  if (exact) return exact;
  const candidates = cycles
    .filter((c) => cycleKey(c.cycle).length > 0 && versionKey.startsWith(cycleKey(c.cycle)))
    .sort(
      (a, b) =>
        new Date(b.releaseDate || b.latestReleaseDate || 0) -
        new Date(a.releaseDate || a.latestReleaseDate || 0)
    );
  return candidates[0] || null;
}

// ---------------------------------------------------------------------------
// GitHub organization scan helpers
// ---------------------------------------------------------------------------

const ghHeaders = {
  "User-Agent": "eol-checker",
  Accept: "application/vnd.github+json",
};
if (GITHUB_TOKEN) ghHeaders.Authorization = `Bearer ${GITHUB_TOKEN}`;

async function ghFetch(url) {
  const res = await fetch(url, { headers: ghHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API error ${res.status} for ${url}`);
  return res.json();
}

async function listOrgRepos(owner) {
  const repos = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await ghFetch(
      `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos?per_page=100&page=${page}`
    );
    if (!Array.isArray(batch)) break;
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

// Latest successful GitHub Actions workflow run for a repo, used as the
// "last deployed on" signal. Cached per repo so every row of a repo shares one
// API call. Repos with Actions disabled, no successful run, or a token without
// the Actions read scope yield a null date plus an explanatory error; neither
// counts as a scan error.
const RUN_CACHE = new Map();

async function getLastSuccessfulRun(owner, repo) {
  const key = `${owner}/${repo}`;
  if (RUN_CACHE.has(key)) return RUN_CACHE.get(key);

  let result;
  try {
    const data = await ghFetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
        repo
      )}/actions/runs?per_page=1&status=success`
    );
    if (data === null) {
      result = { date: null, name: null, url: null, branch: null, error: "No Actions data" };
    } else {
      const run = Array.isArray(data?.workflow_runs) ? data.workflow_runs[0] : null;
      result = run
        ? {
            date: run.updated_at || run.run_started_at || run.created_at || null,
            name: run.name || null,
            url: run.html_url || null,
            branch: run.head_branch || null,
          }
        : { date: null, name: null, url: null, branch: null, error: "No successful run" };
    }
  } catch (err) {
    result = { date: null, name: null, url: null, branch: null, error: err.message };
  }

  RUN_CACHE.set(key, result);
  return result;
}

async function getRepoTree(owner, repo, branch) {
  if (!branch) return [];
  const data = await ghFetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo
    )}/git/trees/${encodeURIComponent(branch)}?recursive=1`
  );
  return Array.isArray(data?.tree) ? data.tree.filter((t) => t.type === "blob") : [];
}

async function fetchRawFile(owner, repo, branch, filePath) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
  const headers = { "User-Agent": "eol-checker" };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) return "";
  const text = await res.text();
  return text.length > 200000 ? "" : text;
}

// Product name aliases (stripped form) for common software so manifests like
// "node:18" or ".nvmrc" match a product entered as "nodejs".
const ALIASES = {
  nodejs: ["node"],
  postgresql: ["postgres"],
  python: ["python3"],
  golang: ["go"],
};

function productVariants(product) {
  const key = toStripped(product);
  const set = new Set([key]);
  for (const [base, aliases] of Object.entries(ALIASES)) {
    if (base === key) for (const a of aliases) set.add(toStripped(a));
  }
  return set;
}

const SETUP_LANG = {
  node: "node",
  python: "python",
  go: "golang",
  java: "java",
  ruby: "ruby",
  dotnet: "dotnet",
  php: "php",
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
    base === "azure-pipelines.yml"
  )
    return "workflow";
  return null;
}

function normVersion(raw) {
  const m = String(raw).match(/\d+(\.\d+)*/);
  return m ? m[0] : null;
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

const FUNCTIONAL_DOMAINS = require(path.join(__dirname, "domains.json"));

// Map a repo to its functional domain using domains.json. Exact repo-name
// matches win, then substring matches (checked in file order); fall back to
// the homepage hostname when no rule matches.
function functionalDomain(repo) {
  const full = (repo.full_name || repo.name || "").toLowerCase();
  const name = (repo.name || "").toLowerCase();
  for (const [key, domain] of Object.entries(FUNCTIONAL_DOMAINS)) {
    if (key === name || key === full) return domain;
  }
  for (const [key, domain] of Object.entries(FUNCTIONAL_DOMAINS)) {
    if (full.includes(key)) return domain;
  }
  return hostOf(repo.homepage);
}

// Detect versions of the requested product inside a file's content.
function detectInFile(type, content, variants) {
  const out = [];
  const add = (version, raw) => {
    const norm = normVersion(version);
    if (norm) out.push({ version: norm, raw: String(raw).trim() });
  };

  if (type === "pin-node" && variants.has("node")) {
    add(content, content);
    return out;
  }
  if (type === "pin-python" && variants.has("python")) {
    add(content, content);
    return out;
  }
  if (type === "pin-ruby" && variants.has("ruby")) {
    add(content, content);
    return out;
  }
  if (type === "pin-terraform" && variants.has("terraform")) {
    add(content, content);
    return out;
  }

  if (type === "tool-versions") {
    for (const line of content.split("\n")) {
      const t = line.trim();
      const m = t.match(/^([^\s]+)(\s+)(v?\d[\w.-]*)/);
      if (m && variants.has(toStripped(m[1]))) add(m[3], t);
    }
    return out;
  }

  if (type === "package-json") {
    try {
      const j = JSON.parse(content);
      for (const key of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
        "engines",
      ]) {
        const sec = j[key];
        if (!sec || typeof sec !== "object") continue;
        for (const [name, ver] of Object.entries(sec)) {
          if (variants.has(toStripped(name))) add(ver, `${name}@${ver}`);
        }
      }
    } catch {}
    return out;
  }

  if (type === "composer-json") {
    try {
      const j = JSON.parse(content);
      for (const key of ["require", "require-dev"]) {
        const sec = j[key];
        if (!sec || typeof sec !== "object") continue;
        for (const [name, ver] of Object.entries(sec)) {
          if (variants.has(toStripped(name))) add(ver, `${name}@${ver}`);
        }
      }
    } catch {}
    return out;
  }

  if (type === "requirements") {
    for (const line of content.split("\n")) {
      const t = line.replace(/\s*#.*$/, "").trim();
      const m = t.match(/^([A-Za-z0-9_.\-]+)\s*([<>=!~]+)\s*(\S+)/);
      if (m && variants.has(toStripped(m[1]))) add(m[3], t);
    }
    return out;
  }

  if (type === "pipfile" || type === "pyproject") {
    for (const line of content.split("\n")) {
      let m = line.match(/^\s*([\w.-]+)\s*=\s*["']([^"']+)["']/);
      if (m && variants.has(toStripped(m[1]))) add(m[2], line.trim());
      m = line.match(/["']([\w.-]+)(?:==|>=|<=|~=|<|>|=)\s*([\d][^"']*)["']/);
      if (m && variants.has(toStripped(m[1]))) add(m[2], line.trim());
    }
    return out;
  }

  if (type === "gemfile") {
    for (const line of content.split("\n")) {
      const m = line.match(/^\s*gem\s+["']([^"']+)["']\s*,\s*["']([^"']+)["']/);
      if (m && variants.has(toStripped(m[1]))) add(m[2], line.trim());
    }
    return out;
  }

  if (type === "go-mod") {
    for (const line of content.split("\n")) {
      const t = line.trim();
      const m = t.match(/^([a-zA-Z0-9_.\-/]+)\s+(v?\d[\w.-]+)/);
      if (m) {
        const name = m[1].split("/").pop();
        if (variants.has(toStripped(name))) add(m[2], t);
      }
    }
    return out;
  }

  if (type === "pom") {
    const re = /<artifactId>\s*([^<]+)<\/artifactId>[\s\S]*?<version>\s*([^<]+)<\/version>/g;
    let m;
    while ((m = re.exec(content))) {
      if (variants.has(toStripped(m[1]))) add(m[2], `${m[1]}@${m[2]}`);
    }
    return out;
  }

  if (type === "gradle") {
    const re = /["']([\w.-]+)(?::([\w.-]+))?[:@](v?\d[\w.\-]+(?:-[^"']*)?)["']/g;
    let m;
    while ((m = re.exec(content))) {
      const name = m[2] || m[1];
      if (variants.has(toStripped(name))) add(m[3], m[0]);
    }
    return out;
  }

  if (type === "docker" || type === "compose" || type === "workflow") {
    for (const line of content.split("\n")) {
      const from = line.match(/^\s*FROM\s+(\S+)/i);
      const image = line.match(/^\s*image:\s*(\S+)/i);
      const container = line.match(/^\s*(?:container|post)\s*:\s*(\S+)/i);
      const spec = (from && from[1]) || (image && image[1]) || (container && container[1]);
      if (!spec) continue;
      const [name, tag] = splitImage(spec);
      if (tag && variants.has(toStripped(name))) add(tag, spec);
    }
  }

  if (type === "workflow") {
    let pending = null;
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (/^-\s/.test(t) && !/^-\s*name\s*:/i.test(t)) pending = null;
      const uses = t.match(/uses:\s*([^\s]+)/i);
      if (uses && uses[1].toLowerCase().includes("/setup-")) {
        const m = uses[1].match(/setup-([a-z0-9-]+)/i);
        const lang = m && m[1].toLowerCase();
        if (lang && SETUP_LANG[lang]) pending = SETUP_LANG[lang];
        continue;
      }
      if (pending) {
        const input = new RegExp(`^${SETUP_INPUT[pending]}\\s*:\\s*["']?([^\\s#'"]+)`, "i");
        const m = t.match(input);
        if (m) {
          add(m[1], t);
          pending = null;
        }
      }
    }
  }

  return out;
}

const EOL_CACHE = new Map();

// The endoflife.date endpoint that supplied a product's EOL data, surfaced in
// the UI so every row is traceable back to its source.
function eolSourceUrl(productId) {
  return productId ? `${EOL_API}/${productId}.json` : null;
}

// Resolve the EOL status for a product/version using endoflife.date.
async function lookupProductEol(product, version, catalog) {
  const cacheKey = `${toKebab(product)}|${cycleKey(version)}`;
  if (EOL_CACHE.has(cacheKey)) return EOL_CACHE.get(cacheKey);

  const match = matchProduct(catalog, product);
  const productId = (match && match.productId) || toKebab(product);

  let cycles = null;
  try {
    cycles = await fetchJson(`${EOL_API}/${productId}.json`);
  } catch {}
  if (!cycles && match) {
    cycles = await fetchJson(`${EOL_API}/${match.productId}.json`);
  }

  const now = Date.now();
  const cycle = Array.isArray(cycles)
    ? findCycleForVersion(cycles, cycleKey(version))
    : null;

  let status;
  if (!cycle) status = "unknown";
  else if (isEol(cycle, now)) status = "eol";
  else if (typeof cycle.support === "string" && new Date(cycle.support).getTime() < now)
    status = "warning";
  else status = "active";

  const result = {
    status,
    productId,
    sourceUrl: eolSourceUrl(productId),
    cycle: cycle?.cycle || null,
    latest: cycle?.latest || null,
    latestReleaseDate: cycle?.latestReleaseDate || null,
    eol: cycle?.eol ?? null,
    support: cycle?.support ?? null,
    isLts: typeof cycle?.lts === "string" || cycle?.lts === true,
  };
  EOL_CACHE.set(cacheKey, result);
  return result;
}

app.get("/api/org", (_req, res) => {
  res.json({ org: GITHUB_ORG });
});

app.get("/api/products", async (_req, res) => {
  try {
    res.json(await fetchJson(`${EOL_API}/all.json`));
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
    catalog = await fetchJson(`${EOL_API}/all.json`);
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

app.post("/api/org-scan", async (req, res) => {
  const { owner, products, limit } = req.body || {};
  if (!owner || typeof owner !== "string") {
    return res.status(400).json({ error: "Provide an 'owner' (GitHub org name)." });
  }
  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: "Provide a non-empty 'products' array." });
  }

  let catalog;
  try {
    catalog = await fetchJson(`${EOL_API}/all.json`);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  let repos;
  try {
    repos = await listOrgRepos(owner);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  if (Number(limit) > 0) repos = repos.slice(0, Number(limit));

  const rows = [];
  const errors = [];
  let scanned = 0;

  for (const repo of repos) {
    if (repo.fork || repo.archived) continue;
    scanned += 1;
    const branch = repo.default_branch;

    let files;
    try {
      files = await getRepoTree(owner, repo.name, branch);
    } catch (err) {
      errors.push({ repo: repo.full_name, message: err.message });
      continue;
    }
    if (!files.length) continue;

    const lastDeployment = await getLastSuccessfulRun(owner, repo.name);

    const candidates = [];
    let workflows = 0;
    let dockers = 0;
    for (const f of files) {
      const type = classifyFile(f.path);
      if (!type) continue;
      if (type === "workflow") {
        if (++workflows <= 5) candidates.push({ type, path: f.path });
        continue;
      }
      if (type === "docker") {
        if (++dockers <= 3) candidates.push({ type, path: f.path });
        continue;
      }
      if (candidates.length >= 25) break;
      candidates.push({ type, path: f.path });
    }

    const contents = (
      await Promise.all(
        candidates.map(async (c) => {
          const text = await fetchRawFile(owner, repo.name, branch, c.path);
          return text ? { type: c.type, path: c.path, text } : null;
        })
      )
    ).filter(Boolean);

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
            domain: functionalDomain(repo),
            domainHost: hostOf(repo.homepage),
            branch,
            lastDeployment,
            name: displayName,
            file: c.path,
            version: d.version,
            versionRaw: d.raw,
            eol,
          });
        }
      }
    }
  }

  res.json({ owner, scannedRepos: scanned, rows, errors });
});

app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));

app.listen(PORT, () => {
  console.log(`EOL checker running at http://localhost:${PORT}`);
});