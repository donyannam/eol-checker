const listEl = document.getElementById("softwareList");
const checkBtn = document.getElementById("checkBtn");
const scanBtn = document.getElementById("scanBtn");
const clearBtn = document.getElementById("clearBtn");
const orgOwnerEl = document.getElementById("orgOwner");
const statusEl = document.getElementById("status");
const resultSection = document.getElementById("resultSection");
const resultsBody = document.getElementById("resultsBody");
const filterEl = document.getElementById("filter");
const resultCountEl = document.getElementById("resultCount");
const orgSection = document.getElementById("orgSection");
const orgBody = document.getElementById("orgBody");
const orgFilterEl = document.getElementById("orgFilter");
const orgDetectionEl = document.getElementById("orgDetection");
const orgCountEl = document.getElementById("orgCount");
const orgSummaryEl = document.getElementById("orgSummary");
const rollupBodyEl = document.getElementById("rollupBody");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const exportExcelBtn = document.getElementById("exportExcelBtn");
const exportRollupBtn = document.getElementById("exportRollupBtn");
const pageInfoEl = document.getElementById("pageInfo");
const prevPageBtn = document.getElementById("prevPageBtn");
const nextPageBtn = document.getElementById("nextPageBtn");

const PAGE_SIZE = 50;
const POLL_MS = 1500;

const state = {
  results: [],
  orgRows: [],
  orgErrors: [],
  summary: null,
  owner: "",
  page: 1,
  jobToken: 0,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseList() {
  const seen = new Set();
  const out = [];
  for (const raw of listEl.value.split(/\n|,/)) {
    const name = raw.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

function setStatus(msg, isError) {
  statusEl.textContent = msg || "";
  statusEl.classList.toggle("error", Boolean(isError));
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      res.ok
        ? "Invalid response from server (expected JSON)."
        : `Request failed (HTTP ${res.status}). The server may need a restart to pick up new endpoints.`
    );
  }
}

// ---------------------------------------------------------------------------
// EOL value formatting (F8)
// ---------------------------------------------------------------------------

// endoflife.date uses booleans when no date is published, and what they mean
// depends on the field: `eol: false` means "not EOL, nothing announced", which
// is not the same as "ended". Rendering every `true` as "Stale" and every
// `false` as "Ended" put "Ended" next to a Supported badge for Redis 8.10.
function fmtDate(value, field) {
  if (value == null) return "";
  if (value === true) return field === "support" ? "Supported (no end date)" : "EOL (no date)";
  if (value === false) return field === "support" ? "Ended (no date)" : "Not announced";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
}

function fmtCount(n) {
  return new Intl.NumberFormat().format(n);
}

function eolStatus(r, now) {
  if (r.error) return "error";
  if (!r.current) return "eol";
  const { eol, support } = r.current;
  if (eol === true) return "eol";
  if (typeof eol === "string" && new Date(eol).getTime() < now) return "eol";
  if (typeof support === "string" && new Date(support).getTime() < now) return "warning";
  return "active";
}

function badge(status) {
  const map = {
    active: ["Supported", "active"],
    warning: ["Support ended", "warning"],
    eol: ["EOL", "eol"],
    unknown: ["Unknown", "unknown"],
    error: ["Not found", "error"],
    constraintsOnly: ["Constraint only", "unknown"],
  };
  const [label, cls] = map[status] || ["", ""];
  return `<span class="badge ${cls}">${label}</span>`;
}

function statusLabel(status) {
  const map = {
    active: "Supported",
    warning: "Support ended",
    eol: "EOL",
    unknown: "Unknown",
    error: "Not found",
    constraintsOnly: "Constraint only",
  };
  return map[status] || status || "";
}

function sourceApiCell(url) {
  if (!url) return '<span class="muted">—</span>';
  return `<a class="mono" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="${escapeHtml(url)}">${escapeHtml(url.replace(/^https?:\/\//, ""))}</a>`;
}

function lastDeploymentCell(d) {
  if (!d) return "—";
  if (!d.date) {
    const why = d.reason ? ` title="${escapeHtml(d.reason)}"` : "";
    return `<span class="muted"${why}>—</span>`;
  }
  const title = [d.name, d.branch && `branch ${d.branch}`, d.event, d.scope]
    .filter(Boolean)
    .join(" · ");
  const date = `<span title="${escapeHtml(title)}">${fmtDate(d.date)}</span>`;
  return d.url
    ? `<a href="${escapeHtml(d.url)}" target="_blank" rel="noopener">${date}</a>`
    : date;
}

function detectionCell(r) {
  if (r.detection !== "constraint") return `<span class="tag pinned" title="A pinned version">pinned</span>`;
  return `<span class="tag constraint" title="A version range, not the version in use">range</span>`;
}

// ---------------------------------------------------------------------------
// Direct EOL lookup
// ---------------------------------------------------------------------------

async function checkEol() {
  const products = parseList();
  if (products.length === 0) {
    setStatus("Enter at least one software name.", true);
    return;
  }

  checkBtn.disabled = true;
  setStatus("");
  statusEl.innerHTML = '<span class="spinner"></span> Checking...';

  try {
    const res = await fetch("/api/eol", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ products }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    state.results = data.results;
    resultSection.hidden = false;
    render();
    const errs = data.results.filter((r) => r.error).length;
    setStatus(
      `Checked ${data.results.length} product${data.results.length === 1 ? "" : "s"}` +
        (errs ? `, ${errs} not found` : "")
    );
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    checkBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Org scan (background job, polled for progress — F5)
// ---------------------------------------------------------------------------

function scanProgressText(progress) {
  if (!progress) return "Scanning org repos...";
  if (progress.phase === "catalog") return "Loading product catalog...";
  if (progress.phase === "listing") return "Listing repositories...";
  if (progress.phase === "teams") return "Mapping repos to GitHub teams...";
  return `Scanning ${fmtCount(progress.repoIndex || 0)}/${fmtCount(progress.repos || 0)} repos · ${progress.repo || ""} · ${fmtCount(progress.matches || 0)} matches`;
}

async function pollScan(jobId, token) {
  for (;;) {
    await sleep(POLL_MS);
    if (state.jobToken !== token) return null; // superseded by a new scan or Clear
    const res = await fetch(`/api/org-scan/jobs/${encodeURIComponent(jobId)}`);
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    if (data.status === "done") return data.result;
    if (data.status === "failed") throw new Error(data.error || "Scan failed.");
    setStatus(scanProgressText(data.progress));
  }
}

async function scanOrg() {
  const products = parseList();
  const owner = orgOwnerEl.value.trim();
  if (products.length === 0) {
    setStatus("Enter at least one software name.", true);
    return;
  }
  if (!owner) {
    setStatus("Enter a GitHub organization name.", true);
    orgOwnerEl.focus();
    return;
  }

  const token = ++state.jobToken;
  checkBtn.disabled = true;
  scanBtn.disabled = true;
  setStatus("");
  statusEl.innerHTML = '<span class="spinner"></span> Starting scan...';

  try {
    const res = await fetch("/api/org-scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, products }),
    });
    const started = await readJson(res);
    if (!res.ok) throw new Error(started.error || `Request failed (${res.status})`);

    const result = await pollScan(started.jobId, token);
    if (!result) return;

    state.orgRows = result.rows || [];
    state.orgErrors = result.errors || [];
    state.summary = result.summary || null;
    state.owner = result.owner || owner;
    state.page = 1;
    orgSection.hidden = false;
    renderOrg();
    setStatus(orgScanStatusText());
  } catch (err) {
    if (state.jobToken === token) setStatus(err.message, true);
  } finally {
    checkBtn.disabled = false;
    scanBtn.disabled = false;
  }
}

// The status line counts repositories, not rows: 379 rows can come from 119
// repositories, and decisions are made per repository (F11).
function orgScanStatusText() {
  const s = state.summary;
  if (!s) return `Found ${state.orgRows.length} matches`;
  const byStatus = s.reposByStatus || {};
  const parts = [
    `Scanned ${fmtCount(s.scannedRepos)} of ${fmtCount(s.listedRepos)} listed repos` +
      (s.archivedRepos || s.forkRepos
        ? ` (${fmtCount(s.archivedRepos || 0)} archived, ${fmtCount(s.forkRepos || 0)} forks skipped)`
        : ""),
    `${fmtCount(s.rows)} matches across ${fmtCount(s.reposWithMatches)} repos`,
  ];
  if (byStatus.eol) parts.push(`${fmtCount(byStatus.eol)} repos EOL`);
  if (byStatus.warning) parts.push(`${byStatus.warning} repos past support`);
  if (byStatus.constraintsOnly) {
    parts.push(`${byStatus.constraintsOnly} repos with range evidence only`);
  }
  const cov = s.coverage || {};
  const missing =
    (cov.truncatedTrees || 0) + (cov.failedFetches || 0) + (cov.skippedFiles || 0);
  if (missing) parts.push(`${fmtCount(missing)} files unreadable or skipped`);
  if (state.orgErrors.length) parts.push(`${state.orgErrors.length} repo errors`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Org results rendering
// ---------------------------------------------------------------------------

function filteredOrgRows() {
  const filter = orgFilterEl.value;
  const detection = orgDetectionEl.value;
  return state.orgRows.filter(
    (r) =>
      (filter === "all" || r.eol.status === filter) &&
      (detection === "all" ||
        (detection === "pinned" ? r.detection !== "constraint" : r.detection === "constraint"))
  );
}

function renderRollup() {
  const s = state.summary;
  if (!s) {
    rollupBodyEl.innerHTML = '<tr><td colspan="3" class="muted">No rollup yet.</td></tr>';
    return;
  }
  const byStatus = s.reposByStatus || {};
  const statusLine = [
    `EOL: ${fmtCount(byStatus.eol || 0)}`,
    `past support: ${fmtCount(byStatus.warning || 0)}`,
    `supported: ${fmtCount(byStatus.active || 0)}`,
    `unknown: ${fmtCount(byStatus.unknown || 0)}`,
    `range evidence only: ${fmtCount(byStatus.constraintsOnly || 0)}`,
  ].join(" · ");
  orgSummaryEl.innerHTML = `<strong>${fmtCount(s.reposWithMatches)} repos</strong> with matches · ${statusLine}`;

  const parts = [];
  for (const d of s.reposByDomain || []) {
    parts.push(`<tr>
      <td>${escapeHtml(d.domain)}</td>
      <td class="num">${fmtCount(d.repos)}</td>
      <td class="num">${d.eol ? fmtCount(d.eol) : "—"}</td>
    </tr>`);
  }
  rollupBodyEl.innerHTML = parts.length
    ? parts.join("")
    : '<tr><td colspan="3" class="muted">No matches.</td></tr>';
}

function renderOrg() {
  renderRollup();

  const rows = filteredOrgRows();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  orgCountEl.textContent = `${fmtCount(rows.length)} of ${fmtCount(state.orgRows.length)} matches`;
  pageInfoEl.textContent = `Page ${fmtCount(state.page)} of ${fmtCount(pages)}`;
  prevPageBtn.disabled = state.page <= 1;
  nextPageBtn.disabled = state.page >= pages;

  if (rows.length === 0) {
    orgBody.innerHTML = `<tr><td colspan="17" class="muted">No software versions detected${
      state.orgRows.length ? " for the current filter" : " in these repos"
    }.</td></tr>`;
    return;
  }

  const parts = [];
  for (const r of pageRows) {
    const e = r.eol;
    const file = r.line ? `${r.file}:${r.line}` : r.file;
    parts.push(`<tr>
      <td><a href="${escapeHtml(r.repoUrl)}" target="_blank" rel="noopener">${escapeHtml(r.repo)}</a></td>
      <td>${r.region ? escapeHtml(r.region) : '<span class="muted">—</span>'}</td>
      <td${r.domainSource ? ` title="${escapeHtml(r.domainSource)}"` : ""}${
        r.domainHost ? ` data-host="${escapeHtml(r.domainHost)}"` : ""
      }>${escapeHtml(r.domain || "Unmapped")}</td>
      <td>${escapeHtml(r.name)}</td>
      <td class="mono">${escapeHtml(r.detectedAs || "—")}</td>
      <td class="mono">${escapeHtml(r.version)}</td>
      <td>${detectionCell(r)}</td>
      <td class="mono muted">${escapeHtml(file)}</td>
      <td class="evidence" title="${escapeHtml(r.versionRaw || "")}">${escapeHtml(r.versionRaw || "—")}</td>
      <td class="mono">${e.cycle ? escapeHtml(e.cycle) : "—"}</td>
      <td class="mono">${e.latest ? escapeHtml(e.latest) : "—"}</td>
      <td>${fmtDate(e.eol, "eol")}</td>
      <td>${fmtDate(e.support, "support")}</td>
      <td>${sourceApiCell(e.sourceUrl)}</td>
      <td>${lastDeploymentCell(r.lastDeployment)}</td>
      <td>${badge(r.repoStatus || e.status)}</td>
      <td>${badge(e.status)}</td>
    </tr>`);
  }
  orgBody.innerHTML = parts.join("");
}

// ---------------------------------------------------------------------------
// CSV export (F9, F11)
// ---------------------------------------------------------------------------

function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Excel reads 3.10 as the number 3.1 and 8.0.x as 8. Wrapping the value in
// ="..." forces a text cell without changing the characters.
function csvTextCell(value) {
  if (value == null || value === "") return "";
  const s = String(value).replace(/"/g, '""');
  return csvCell(`="${s}"`);
}

function downloadCsv(filename, lines) {
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const ROW_HEADER = [
  "Repository",
  "Repository URL",
  "Region",
  "Domain",
  "Software",
  "Detected as",
  "Used version",
  "Version spec",
  "Detection",
  "Confidence",
  "File",
  "Line",
  "Evidence",
  "Cycle",
  "Latest",
  "EOL",
  "Support until",
  "Source API",
  "Status",
  "Repo status",
  "Last deploy run",
  "Last deploy reason",
  "Last deploy scope",
  "Branch",
];

// Columns Excel would coerce to a number: "3.10" becomes 3.1, "8.0.x" becomes 8.
const EXCEL_TEXT_COLUMNS = new Set([
  ROW_HEADER.indexOf("Used version"),
  ROW_HEADER.indexOf("Version spec"),
  ROW_HEADER.indexOf("Cycle"),
  ROW_HEADER.indexOf("Latest"),
]);

function exportOrgCsv(asTextForExcel) {
  const rows = filteredOrgRows();
  const lines = [ROW_HEADER.join(",")];
  for (const r of rows) {
    const e = r.eol;
    const values = [
      r.repo,
      r.repoUrl,
      r.region,
      r.domain,
      r.name,
      r.detectedAs,
      r.version,
      r.versionSpec,
      r.detection,
      r.confidence,
      r.file,
      r.line,
      r.versionRaw,
      e.cycle,
      e.latest,
      fmtDate(e.eol, "eol"),
      fmtDate(e.support, "support"),
      e.sourceUrl,
      statusLabel(e.status),
      statusLabel(r.repoStatus || e.status),
      r.lastDeployment?.date ? fmtDate(r.lastDeployment.date) : "",
      r.lastDeployment?.reason || "",
      r.lastDeployment?.scope || "",
      r.branch,
    ];
    lines.push(
      values
        .map((v, i) => (asTextForExcel && EXCEL_TEXT_COLUMNS.has(i) ? csvTextCell(v) : csvCell(v)))
        .join(",")
    );
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const suffix = asTextForExcel ? "-excel" : "";
  downloadCsv(`eol-org-scan-${state.owner || "org"}-${stamp}${suffix}.csv`, lines);
}

// Two blocks in one file: the per-repository rollup, then a blank line and the
// per-domain summary.
function exportRollupCsv() {
  const s = state.summary;
  if (!s) return;
  const lines = ["Repository,Repository URL,Region,Domain,Rows,Pinned rows,Range rows,EOL rows,Worst status,Range evidence only"];
  for (const r of repoRollup()) {
    lines.push(
      [
        r.repo,
        r.repoUrl,
        r.region,
        r.domain,
        r.rows,
        r.pinnedRows,
        r.constraintRows,
        r.eolRows,
        statusLabel(r.constraintsOnly ? "constraintsOnly" : r.worst),
        r.constraintsOnly ? "yes" : "no",
      ]
        .map(csvCell)
        .join(",")
    );
  }
  lines.push("");
  lines.push("Domain,Repos,Repos with an EOL version");
  for (const d of s.reposByDomain || []) {
    lines.push([d.domain, d.repos, d.eol].map(csvCell).join(","));
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  downloadCsv(`eol-org-rollup-${state.owner || "org"}-${stamp}.csv`, lines);
}

// Rebuild the repo rollup on the client so the CSV matches the rows on screen
// under the current filter.
function repoRollup() {
  const rank = { active: 1, unknown: 0, warning: 2, eol: 3 };
  const byRepo = new Map();
  for (const r of filteredOrgRows()) {
    let e = byRepo.get(r.repo);
    if (!e) {
      e = {
        repo: r.repo,
        repoUrl: r.repoUrl,
        region: r.region,
        domain: r.domain,
        rows: 0,
        pinnedRows: 0,
        constraintRows: 0,
        eolRows: 0,
        worst: "active",
        constraintsOnly: true,
      };
      byRepo.set(r.repo, e);
    }
    e.rows += 1;
    if (r.detection === "constraint") e.constraintRows += 1;
    else e.pinnedRows += 1;
    if (r.detection !== "constraint" && r.eol.status === "eol") e.eolRows += 1;
    if (r.detection === "constraint") continue;
    e.constraintsOnly = false;
    if ((rank[r.eol.status] ?? 0) > (rank[e.worst] ?? 0)) e.worst = r.eol.status;
  }
  return [...byRepo.values()];
}

function render() {
  const now = Date.now();
  const filter = filterEl.value;
  const rows = state.results.filter((r) =>
    filter === "all" ? true : eolStatus(r, now) === filter
  );

  resultCountEl.textContent = `${rows.length} of ${state.results.length}`;

  if (rows.length === 0) {
    resultsBody.innerHTML = `<tr><td colspan="8" class="muted">No results match the current filter.</td></tr>`;
    return;
  }

  resultsBody.innerHTML = rows
    .map((r) => {
      if (r.error) {
        return `<tr class="row-error">
          <td class="name-cell">${escapeHtml(r.name)}</td>
          <td colspan="7">${escapeHtml(r.error)}</td>
        </tr>`;
      }
      const c = r.current;
      const status = eolStatus(r, now);
      return `<tr>
        <td>${escapeHtml(r.name)}</td>
        <td class="mono">${c && c.latest ? escapeHtml(c.latest) : "—"}</td>
        <td class="mono">${c && c.releaseCycle ? escapeHtml(c.releaseCycle) : "—"}</td>
        <td>${c ? fmtDate(c.latestReleaseDate) : "—"}</td>
        <td>${c ? fmtDate(c.eol, "eol") : "All cycles EOL"}</td>
        <td>${c ? fmtDate(c.support, "support") : "—"}</td>
        <td>${sourceApiCell(r.sourceUrl)}</td>
        <td>${badge(status)}</td>
      </tr>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function resetPage() {
  state.page = 1;
}

checkBtn.addEventListener("click", checkEol);
scanBtn.addEventListener("click", scanOrg);
filterEl.addEventListener("change", render);
orgFilterEl.addEventListener("change", () => {
  resetPage();
  renderOrg();
});
orgDetectionEl.addEventListener("change", () => {
  resetPage();
  renderOrg();
});
exportCsvBtn.addEventListener("click", () => exportOrgCsv(false));
exportExcelBtn.addEventListener("click", () => exportOrgCsv(true));
exportRollupBtn.addEventListener("click", exportRollupCsv);
prevPageBtn.addEventListener("click", () => {
  state.page -= 1;
  renderOrg();
});
nextPageBtn.addEventListener("click", () => {
  state.page += 1;
  renderOrg();
});
clearBtn.addEventListener("click", () => {
  listEl.value = "";
  resultSection.hidden = true;
  orgSection.hidden = true;
  state.results = [];
  state.orgRows = [];
  state.orgErrors = [];
  state.summary = null;
  state.page = 1;
  state.jobToken += 1; // stop polling any in-flight scan
  setStatus("");
});
listEl.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") checkEol();
});

(async () => {
  if (!listEl.value.trim()) listEl.value = "nodejs\npython\npostgresql\nexpress";
  try {
    const res = await fetch("/api/org");
    const cfg = await readJson(res);
    if (cfg.org) orgOwnerEl.value = cfg.org;
    if (Array.isArray(cfg.allowedOrgs) && cfg.allowedOrgs.length) {
      orgOwnerEl.title = `Scans are limited to: ${cfg.allowedOrgs.join(", ")}`;
      if (!cfg.allowedOrgs.includes(orgOwnerEl.value.trim().toLowerCase())) {
        orgOwnerEl.value = cfg.allowedOrgs[0];
      }
    }
    // Show the previous run while a fresh scan runs.
    const latest = await fetch(
      `/api/org-scan/latest${cfg.org ? `?owner=${encodeURIComponent(cfg.org)}` : ""}`
    );
    if (latest.ok) {
      const data = await readJson(latest);
      if (data.result) {
        state.orgRows = data.result.rows || [];
        state.orgErrors = data.result.errors || [];
        state.summary = data.result.summary || null;
        state.owner = data.result.owner || cfg.org;
        orgSection.hidden = false;
        renderOrg();
        setStatus(`${orgScanStatusText()} · stored run from ${data.finishedAt}`);
      }
    }
  } catch {}
})();