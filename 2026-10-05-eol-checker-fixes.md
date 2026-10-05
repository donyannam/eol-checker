# EOL Checker — Fix Report

Oct 5, 2026 · addresses `2026-10-05-eol-checker-review.md` (line numbers there refer to commit `9f04184`)

All twelve findings (F1–F12) are implemented, tested and documented. 44 `node:test`
regressions pass. The two critical findings are fixed: F1 no longer reports other
languages' versions as Node.js, and F2 now scans all 998 active repositories instead of 392.

The 2026-10-01 export is still invalid and should not be shared. It needs regenerating on
top of these fixes, which requires a GitHub App installation token or several PAT hours
(see [Not covered](#not-covered)).

## Summary

| # | Finding | Severity | Fix | Where | Tests |
| --- | --- | --- | --- | --- | --- |
| F1 | Workflow `setup-*` versions reported under whatever product was scanned | Critical | `SETUP_PRODUCTS` gate | `server.js:669-696`, `server.js:838-841` | 10 |
| F2 | Repo listing stopped after 10 pages; 606 active repos never scanned | Critical | Page to a short page | `server.js:369-405` | 2 |
| F3 | "Last deployment" is any successful run, and the query is unstable | High | Filter client-side, scope to deploy runs, always give a reason | `server.js:418-532` | 4 |
| F4 | Version ranges reported as the version in use | High | Tag pinned vs constraint | `server.js:637-664`, `server.js:1222` | 6 |
| F5 | Not ready for a shared server | High | Allow-list, loopback bind, App auth, background jobs, TTL caches | `server.js:30-57`, `server.js:1263-1352`, `server.js:1453-1499` | — |
| F6 | Cycle matching by digit-stripped prefix | Medium | Dotted-component match, longest wins | `server.js:210-244` | 5 |
| F7 | Silent per-repo caps and dropped fetches | Medium | Caps configurable and reported | `server.js:1081-1107`, `server.js:534-579` | 5 |
| F8 | `true`/`false` share one label set | Medium | Field-aware labels | `public/app.js:78-84` | — |
| F9 | Export omits the matched line; Excel reads `3.10` as 3.1 | Medium | Evidence/line columns, Excel-text export | `public/app.js:436-482` | 1 |
| F10 | 54 of 119 repos unmapped; others misfiled by substring | Medium | Exact-keyed repo + team tables, "Unmapped" | `domains.json`, `server.js:891-903` | 5 |
| F11 | Status line counts rows, not repositories | Low | Repo-level rollup and summary | `server.js:1004-1077`, `public/app.js` | 4 |
| F12 | REQUIREMENTS.md misstates org size and behavior | Low | Rewritten to match the code | `REQUIREMENTS.md`, `README.md` | — |

## F1 — Other languages' setup steps (Critical)

**Was:** the workflow extractor remembered the language of any `setup-*` step but never
compared it with the product being scanned, so every `*-version:` input was emitted.
`setup-dotnet 8.0.x` became Node 8.185 rows of the 379-row export were other languages.
It also ran in reverse: scanning `python` reported `node-version: 24` as Python 24, and
the UI's four-product default emitted every setup version four times.

**Now:** a setup step only contributes a version when the product being scanned is the
one that step installs. Any other `setup-*` action clears the pending input, so it cannot
leak into a later `*-version` line either.

```js
const SETUP_PRODUCTS = {
  node: ["node", "nodejs"], python: ["python", "python3"], golang: ["go", "golang"],
  java: ["java"], ruby: ["ruby"], dotnet: ["dotnet"], php: ["php"],
};
```

`SETUP_LANG` (action → product) and `SETUP_INPUT` (product → input name) were added
alongside it; the input names are now data rather than a hardcoded list, which is what
lets an unknown `setup-*` action be rejected.

**Verified:** `setup-dotnet`, `setup-go`, `setup-ruby` and `setup-java` produce no Node
rows; `setup-node` still matches a `nodejs` scan; the reverse leak is closed; container
images in workflows are unaffected. A whole-org scan of setup-dotnet workflows produces
zero rows.

## F2 — Repo listing cap (Critical)

**Was:** `listOrgRepos()` stopped after 10 pages of 100. 606 of 998 active repositories
were never listed, and `limit` was applied before forks and archived repos were removed,
so `limit: 40` could scan fewer than 40.

**Now:** paging continues until a short page. `MAX_REPO_PAGES` (default 200) is a safety
ceiling only, and hitting it throws rather than returning a partial org. `limit` applies
after forks and archived repos are removed. Every scan reports the counts the review asked
for: `listedRepos`, `forkRepos`, `archivedRepos`, `listingTruncated`, `scannedRepos`.

**Verified live against masterysystems:** 1,766 listed, 29 forks, 739 archived, 998
scannable, `listingTruncated: false`. A test stubs 1,205 repositories and asserts the 13th
page is read.

## F3 — Last deployment (High)

**Was:** the first result of `/actions/runs?status=success&per_page=1` — any workflow, any
branch, any trigger. The query itself is unstable: identical calls returned 2025-12-19,
then 2026-03-13, then 2026-10-05 for `configuration`, because GitHub returns partial result
sets under that filter for busy repos. A blank cell was ambiguous between Actions disabled,
no runs, and a token without `actions:read`.

**Now**, following all four suggested fixes:

1. The `status` filter is dropped; `conclusion == "success"` is checked client-side.
2. `pickDeployRun()` accepts only the default branch and deploy-type triggers (`push`,
   `workflow_dispatch`, `release`, `deployment`, `workflow_run`), so scheduled jobs and
   PR checks on other branches are skipped.
3. The column is renamed **Last deploy run** and carries a `scope` string. The review
   noted that production deploys actually run through Argo CD from
   `mastermind-release/release/pipeline/prod.json`; that is a documented backlog item, not
   something this change can resolve, so the column no longer implies a production date.
4. `deployRunReason()` explains every blank: `No workflow runs`, `No successful run`,
   `No successful run on <branch>`, `No deploy-type run on <branch> in the last N runs`, or
   `Actions data unavailable (repo or token)`. The reason is exported next to the blank
   cell and is not counted as a scan error.

Because the column may now be legitimately blank where it previously showed a
misleading date, `configuration` and `noc-mastermind-dashboards` will show blanks with
reasons. That is the correct reading: neither has a successful push-triggered run on its
default branch.

## F4 — Ranges read as versions (High)

**Was:** `normVersion()` kept the first number in a spec, so `>=8.0.0` became 8.0.0 and
`^16 || ^18 || ^20 || >=22` became 16. 65 rows were lower bounds, from `engines` and
`peerDependencies`, which say what a package accepts rather than what runs.

**Now:** `isConstraintSpec()` recognizes range operators (caret, tilde, comparator,
wildcard, union, hyphen range). Constrained rows carry the raw spec, are tagged
`detection: "constraint"` with `confidence: "Medium"`, and are **excluded from the EOL
counts** in the scan summary. A repository whose only evidence is a range is reported as
`constraintsOnly` in the rollup rather than as a clean repository. Pinned rows keep High
confidence. Every row also carries the line it was read from and the matched source line.

## F5 — Shared-server readiness (High)

All five rows of the review's table, plus the smaller escaping item:

| Area | Change |
| --- | --- |
| Access | Binds `127.0.0.1` by default; `HOST` must be set explicitly to expose it, and the docs state that a shared deployment must put company SSO in front — the app has no auth of its own |
| Scan target | Scans restricted to `GITHUB_ORG` + `SCAN_ALLOWED_ORGS`; anything else is `403` before any GitHub call |
| Credentials | GitHub App installation token supported (`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`, JWT signed with `node:crypto`, no dependency added), PAT kept as fallback; `/api/org` reports which is in use without revealing either |
| Execution | `POST /api/org-scan` returns `202` with a job id; `createScanJob()` runs the scan off the request cycle with progress, stores the result with timestamps, and `GET /api/org-scan/latest` serves it back for `JOB_TTL_MS` |
| Caching | TTLs everywhere: EOL 24h, errors 5m, catalog 24h, Actions runs 1h; rate limits (403/429) raise a typed error carrying the reset time and stop the repo loop instead of burning quota |
| XSS | `cycle` and `latest` are now escaped like every other dynamic string |

The smaller item from the review — `cycle`/`latest` rendered without `escapeHtml()`, in
breach of FR-6.5 and NFR-2 — is fixed as part of the frontend rewrite.

## F6 — Cycle matching (Medium)

**Was:** `cycleKey()` stripped dots before matching. Go `1.25` → `125` landed on Node cycle
12; `3.10` → `310` landed on cycle 3.

**Now:** `findCycleForVersion()` compares dotted components and returns the longest cycle
that is a component-wise prefix of the version. `24.15.0` → cycle 24, `3.10.4` → cycle
`3.10` (not 3, and never 3.14), `1.25` cannot match cycle 12.

## F7 — Silent per-repo limits (Medium)

**Was:** 5 workflows, 3 Dockerfiles and 25 files per repo, in tree order, with `break` at 25
so later candidates were dropped too; a truncated tree was unchecked; non-YAML files under
`.github/workflows` parsed as workflows; `fetchRawFile()` returned `""` on any failure.
Across 119 repos: 667 workflow files never read, 33 repos over the Dockerfile cap, 700+
manifests unread behind the 25-file cap, 1 truncated tree, 7 non-YAML files.

**Now:**

- Caps default to `0` (uncapped) and are per-type configurable via
  `MAX_WORKFLOWS_PER_REPO`, `MAX_DOCKERFILES_PER_REPO`, `MAX_FILES_PER_REPO`.
- `selectCandidates()` returns `{ candidates, skipped }`; skipped paths are recorded in
  `errors`, so a cap can never silently reduce coverage.
- `getRepoTree()` checks `truncated` and reports an incomplete tree.
- `fetchRawFile()` returns a reason instead of an empty string, reported as
  `Could not read <path>: <reason>`.
- `classifyFile()` treats only `.yml`/`.yaml` under `.github/workflows` as workflows, so
  `Android-Deploy-Dev-Internal-devapp.txt` is no longer parsed.
- Counts surface in `summary.coverage` and the status line.

## F8 — True/false labels (Medium)

`fmtDate()` mapped every `true` to "Stale" and every `false` to "Ended" regardless of
column, so Redis 8.10 showed EOL "Ended" beside Support "Stale" next to a "Supported"
badge. Labels are now field-aware: `eol: true` → "EOL (no date)", `eol: false` → "Not
announced", `support: true` → "Supported (no end date)", `support: false` → "Ended (no
date)".

## F9 — Export (Medium)

The CSV now carries Evidence (the matched line), Line, Detected as (the name the manifest
used), the raw spec, Detection and Confidence, Region, the repo's worst status, and the
reason behind any blank last-deploy cell — 24 columns.

The Excel export writes the four version-shaped columns as `="3.10"` text so `3.10` is not
read as 3.1. The column set is derived from `ROW_HEADER.indexOf()` rather than hardcoded
indices, so it cannot silently drift when the header changes. A third export writes the
per-repository rollup and the per-domain summary.

## F10 — Domain mapping (Medium)

**Was:** ordered substring rules describing technical layers, not Mastery's domains.
`mastery-credit` → EDI because "edi" is inside "credit"; `mass-uploads-library` and
`capacity-load-testing` → Load Status because "load" is inside "upload"/"load"; 54 of 119
repos unmapped. Rules also matched `full_name`, so the org prefix took part in every match.

**Now:** two exact-keyed tables. A `repos` override wins; otherwise the repository's owning
GitHub team is looked up in `teams`. Substring matching is gone. Unmapped repos are
reported as **Unmapped** — never blank, never a homepage hostname. Each row carries
`region` and `domainSource` so a mapping can be audited back to where it came from.

The Compass taxonomy (5 regions, 6 categories) is in `domains.json` as `_taxonomy` for
validation. `npm run domains:seed <org>` prints the org's team slugs with empty
region/category to fill in, plus the repos still Unmapped afterwards.

**Needs your input:** the actual team → region/category assignments. Compass's own repo
links are thin — the review notes only 77 of 312 services match a GitHub repo — so this
cannot be derived from data. Until it is filled in, real repos resolve to `Unmapped`,
which is honest but not useful.

## F11 — Rows vs. repositories (Low)

**Was:** "Scanned N repos, found M software matches", where M counted rows: 379 rows from
119 repos.

**Now:** the summary separates `scannedRepos`, `listedRepos`, `reposWithMatches`, `rows`,
`pinnedRows` and `constraintRows`. `rollupByRepo()` gives each repository its worst status
and stamps it onto every row, so a decision can be read per repo. The UI shows a rollup
(repos by worst status, repos by domain) above the table, with its own CSV export. The
status line counts repositories.

## F12 — REQUIREMENTS.md (Low)

All six stale statements corrected, and the sections between them brought in line with what
shipped: FR-2 now covers the background-job flow and the full response shape; FR-3 gains
the setup-step gate and the cap/fetch reporting; FR-4 gains range handling and per-field
labels; FR-5 becomes the two-table exact mapping; FR-6 gains pagination and the three
exports; §9 is rewritten (components, data flow, API contract, detection pipeline, domain
mapping, security, resilience, performance); §10 documents every env var with defaults;
acceptance criteria go from 8 to 13, including the F1 and F4 cases. NFR-1 no longer sizes
the scan for a ~50-repo org. README.md was rewritten for credentials, the GitHub App,
tuning, exports, domains and tests.

## Verification

- `npm test` — 44 pass, 0 fail (~330ms). Covers F1, F2, F3, F4, F6, F7, F10, F11.
- `node --check server.js` and `node --check public/app.js` clean.
- Endpoint smoke test: `/api/health`, `/api/org`, org allow-list rejection (`403`), JSON
  404 for unmatched `/api/*`, static root (`200`).
- Live job scan on masterysystems: 1,766 listed → 2 scanned, 11 rows (5 pinned, 6 ranges),
  0 errors, `constraintsOnly` rollup correct, result re-served by `/api/org-scan/latest`.
- `git diff --check` clean. Nothing is committed yet.

## Not covered

These are real gaps, not oversights:

- **The 2026-10-01 export is not regenerated.** Its 379 rows are still wrong. A full-org
  export needs a GitHub App (15,000 req/hr); on a PAT (5,000/hr) it does not fit in one
  hour.
- **True production deployment dates.** Still the newest qualifying Actions run, not the
  `sha` history of `prod.json` or Argo CD sync history. The column is renamed and scoped so
  it cannot be misread as a production date.
- **`domains.json` teams is empty.** See F10.
- **SSO and durable storage.** Loopback binding and an allow-list are the local-use answer.
  A shared or scheduled deployment needs SSO in front and job persistence; scans and
  results live in process memory.
- **Actions-runtime checks.** Out of scope by the review's own scope note: the checker
  measures the Node version an application *declares*. GitHub's removal of Node 20 from
  runners applies to JavaScript actions declaring `runs.using: node20`, so a repo can
  deploy while declaring Node 20. That needs a separate `uses:` analysis.