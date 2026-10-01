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
const orgCountEl = document.getElementById("orgCount");
const exportCsvBtn = document.getElementById("exportCsvBtn");

const state = { results: [], orgRows: [], orgErrors: [], owner: "" };

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
    setStatus(`Checked ${data.results.length} product${data.results.length === 1 ? "" : "s"}` + (errs ? `, ${errs} not found` : ""));
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    checkBtn.disabled = false;
  }
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

function fmtDate(value) {
  if (value == null) return "";
  if (value === true) return "Ongoing";
  if (value === false) return "Ended";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
}

function badge(status) {
  const map = {
    active: ["Supported", "active"],
    warning: ["Support ended", "warning"],
    eol: ["EOL", "eol"],
    unknown: ["Unknown", "unknown"],
    error: ["Not found", "error"],
  };
  const [label, cls] = map[status] || ["", ""];
  return `<span class="badge ${cls}">${label}</span>`;
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

  checkBtn.disabled = true;
  scanBtn.disabled = true;
  setStatus("");
  statusEl.innerHTML = '<span class="spinner"></span> Scanning org repos... (this can take a while)';

  try {
    const res = await fetch("/api/org-scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, products }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    state.orgRows = data.rows;
    state.orgErrors = data.errors || [];
    state.owner = data.owner || owner;
    orgSection.hidden = false;
    renderOrg();
    const errs = data.rows.filter((r) => r.eol.status === "eol").length;
    setStatus(
      `Scanned ${data.scannedRepos} repos, found ${data.rows.length} software ` +
        `${data.rows.length === 1 ? "match" : "matches"}` +
        (errs ? `, ${errs} EOL` : "") +
        (state.orgErrors.length ? `, ${state.orgErrors.length} repo errors` : "")
    );
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    checkBtn.disabled = false;
    scanBtn.disabled = false;
  }
}

function filteredOrgRows() {
  const filter = orgFilterEl.value;
  return state.orgRows.filter((r) =>
    filter === "all" ? true : r.eol.status === filter
  );
}

function renderOrg() {
  const rows = filteredOrgRows();
  orgCountEl.textContent = `${rows.length} of ${state.orgRows.length} matches`;

  const parts = [];

  if (rows.length === 0 && state.orgRows.length === 0 && !state.orgErrors.length) {
    orgBody.innerHTML = `<tr><td colspan="10" class="muted">No software versions detected in these repos.</td></tr>`;
    return;
  }

  for (const r of rows) {
    const e = r.eol;
    parts.push(`<tr>
      <td><a href="${escapeHtml(r.repoUrl)}" target="_blank" rel="noopener">${escapeHtml(r.repo)}</a></td>
      <td${r.domainHost ? ` title="${escapeHtml(r.domainHost)}"` : ""}>${r.domain ? escapeHtml(r.domain) : "—"}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.version)}</td>
      <td><span class="mono muted">${escapeHtml(r.file)}</span></td>
      <td>${e.cycle ? e.cycle : "—"}</td>
      <td>${e.latest ? e.latest : "—"}</td>
      <td>${fmtDate(e.eol)}</td>
      <td>${fmtDate(e.support)}</td>
      <td>${badge(e.status)}</td>
    </tr>`);
  }

  if (rows.length === 0) {
    parts.push(
      `<tr><td colspan="10" class="muted">No matches for the current filter.</td></tr>`
    );
  }

  for (const err of state.orgErrors) {
    parts.push(`<tr class="row-error">
      <td class="name-cell">${escapeHtml(err.repo)}</td>
      <td colspan="9">${escapeHtml(err.message)}</td>
    </tr>`);
  }

  orgBody.innerHTML = parts.join("");
}

function statusLabel(status) {
  const map = { active: "Supported", warning: "Support ended", eol: "EOL", unknown: "Unknown", error: "Not found" };
  return map[status] || status;
}

function exportOrgCsv() {
  const rows = filteredOrgRows();
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["Repository", "Domain", "Software", "Used version", "File", "Cycle", "Latest", "EOL", "Support until", "Status"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const e = r.eol;
    lines.push(
      [
        r.repo,
        r.domain || "",
        r.name,
        r.version,
        r.file,
        e.cycle || "",
        e.latest || "",
        fmtDate(e.eol),
        fmtDate(e.support),
        statusLabel(e.status),
      ]
        .map(esc)
        .join(",")
    );
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `eol-org-scan-${state.owner || "org"}-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function render() {
  const now = Date.now();
  const filter = filterEl.value;
  const rows = state.results.filter((r) =>
    filter === "all" ? true : eolStatus(r, now) === filter
  );

  resultCountEl.textContent = `${rows.length} of ${state.results.length}`;

  if (rows.length === 0) {
    resultsBody.innerHTML = `<tr><td colspan="7" class="muted">No results match the current filter.</td></tr>`;
    return;
  }

  resultsBody.innerHTML = rows
    .map((r) => {
      if (r.error) {
        return `<tr class="row-error">
          <td class="name-cell">${escapeHtml(r.name)}</td>
          <td colspan="6">${escapeHtml(r.error)}</td>
        </tr>`;
      }
      const c = r.current;
      const status = eolStatus(r, now);
      return `<tr>
        <td>${escapeHtml(r.name)}</td>
        <td>${c ? c.latest : "—"}</td>
        <td>${c ? c.releaseCycle : "—"}</td>
        <td>${c ? fmtDate(c.latestReleaseDate) : "—"}</td>
        <td>${c ? fmtDate(c.eol) : "All cycles EOL"}</td>
        <td>${c ? fmtDate(c.support) : "—"}</td>
        <td>${badge(status)}</td>
      </tr>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

checkBtn.addEventListener("click", checkEol);
scanBtn.addEventListener("click", scanOrg);
filterEl.addEventListener("change", render);
orgFilterEl.addEventListener("change", renderOrg);
exportCsvBtn.addEventListener("click", exportOrgCsv);
clearBtn.addEventListener("click", () => {
  listEl.value = "";
  resultSection.hidden = true;
  orgSection.hidden = true;
  state.results = [];
  state.orgRows = [];
  state.orgErrors = [];
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
  } catch {}
})();