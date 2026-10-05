# Software EOL Checker — Requirements Document

## 1. Overview

The Software EOL Checker is a web application that helps an organization track the
End-of-Life (EOL) status of the software it uses. Users enter software names and receive
their current version and EOL dates. The application can also scan every repository in a
GitHub organization to detect which versions of the entered software are actually in use,
and report whether each detected version is still supported or EOL.

The tool is currently scoped to the `masterysystems` organization.

## 2. Goals

- G1: Provide a fast, low-friction way to check the EOL status of a given software product.
- G2: Automatically inventory the software versions used across all repositories in an
  organization's GitHub account.
- G3: Highlight which in-use versions are End-of-Life or past support so teams can plan
  upgrades.
- G4: Group scan results by functional business domain so risks are easy to triage by team.

## 3. Non-Goals (Out of Scope)

- Automatically upgrading or patching dependencies.
- Enforcing policy or blocking deployments based on EOL status.
- Full dependency-tree analysis (transitive dependencies are not resolved).
- Bi-directory sync with SonarQube or other quality tools.
- Scanning private repositories using unauthenticated access.

## 4. Assumptions and Dependencies

- The GitHub organization is `masterysystems`: **1,766 repositories — 998 active,
  739 archived and 29 forks** (measured 2026-10-05). Its repositories are **private**.
- Scanning private repositories and reading private file contents requires a GitHub
  credential with `contents: read` on the target repositories. A **GitHub App
  installation token** is preferred (scoped, rotatable, 15,000 req/hr); a fine-grained
  personal access token remains supported as a fallback (5,000 req/hr).
- The `endoflife.date` public API provides authoritative product, cycle, and EOL data.
- Runtime: Node.js >= 18 (native `fetch`), single dependency `express`.
- No database; state is ephemeral per process: TTL caches for EOL data and Actions
  lookups, plus stored scan results for the most recent scans.

## 5. Actors

| Actor | Description |
| --- | --- |
| User | Engineer, SRE, or manager who checks software EOL and org software inventory. |
| GitHub | Source of the organization's repository and file inventory. |
| endoflife.date | External source of product versions and EOL dates. |

## 6. Functional Requirements

### FR-1 Direct EOL lookup
- **FR-1.1** The user can enter one or more software names (one per line or comma-separated,
  duplicates ignored) and request an EOL check.
- **FR-1.2** For each product the UI shows: current version, current release cycle, latest
  release date, EOL date, support-until date, and a status badge
  (`Supported` / `Support ended` / `EOL` / `Not found`).
- **FR-1.3** Results can be filtered by status (`All`, `Active`, `EOL`, `Errors`).

### FR-2 GitHub organization scan
- **FR-2.1** The user can supply an organization name (defaulting to the configured
  `GITHUB_ORG`) and a software list, then request an org scan. With `GITHUB_ORG` or
  `SCAN_ALLOWED_ORGS` configured, any other organization is rejected with `403`.
- **FR-2.2** The scan iterates **all** non-fork, non-archived repositories in the
  organization: the repo listing pages until a short page (no fixed page cap), then
  forks and archived repositories are removed. `MAX_REPO_PAGES` is a safety ceiling
  only, and hitting it fails the scan rather than returning a partial org.
- **FR-2.3** For each entered product, the scan reports per repository/file/version:
  repository name and URL, Compass region, functional domain, requested software name,
  the name the manifest used, the detected version, the raw spec, whether the match is
  a pinned version or a range, a confidence (High/Medium), the file and line, the
  matched source line, matching release cycle, latest version, EOL date, support date,
  the repository's last deploy run, the repository's worst status and the row status
  (`Supported` / `Support ended` / `EOL` / `Unknown` / `Not found`).
- **FR-2.4** Forked and archived repositories are excluded from the scan, and the
  response reports how many of each were seen.
- **FR-2.5** Optional `limit` parameter restricts the number of repositories **scanned**,
  applied after forks and archived repositories are removed, so `limit: 40` scans 40
  repositories rather than "up to 40 listed".
- **FR-2.6** Repo-level failures (inaccessible tree, truncated tree, unreadable file,
  skipped files) are reported in an `errors` list with the reason, rather than aborting
  the scan or silently dropping results.
- **FR-2.7** Each row reports the repository's **last deploy run**: the newest workflow
  run with `conclusion == "success"` on the repository's default branch whose trigger
  is `push`, `workflow_dispatch`, `release`, `deployment` or `workflow_run`. The GitHub
  query carries **no `status` filter** — the filter is applied client-side, because
  GitHub returns partial result sets for busy repositories under that filter. Scheduled
  jobs and pull-request checks on other branches are therefore not reported as
  deployments.
- **FR-2.8** When there is no such run, the cell is empty (`—` in the UI, empty in CSV)
  **and the reason is carried alongside it** (`No workflow runs`, `No successful run`,
  `No successful run on <branch>`, `No deploy-type run on <branch> in the last N runs`,
  `Actions data unavailable`, or the API error). It is not counted as a scan error.
- **FR-2.9** The Actions lookup is cached per repository so all rows from the same repo
  share a single API call, with a TTL (`RUN_CACHE_TTL_MS`, default 1 hour).
- **FR-2.10** A scan runs as a **background job**. `POST /api/org-scan` returns `202`
  with a job id; the client polls `GET /api/org-scan/jobs/{id}` for progress and the
  stored result. Completed results are retained for `JOB_TTL_MS` and served by
  `GET /api/org-scan/latest`, which is the basis for scheduled runs and history.
- **FR-2.11** The response includes a `summary` that counts **repositories, not rows**:
  repositories by worst status, repositories by domain, pinned vs. range rows, and
  coverage counters (truncated trees, failed fetches, skipped files).

### FR-3 Version detection
- **FR-3.1** The scanner detects product versions from the following file types:
  `package.json` (dependencies, devDependencies, peerDependencies,
  optionalDependencies, engines), `composer.json`,
  `requirements*.txt`, `Pipfile`, `pyproject.toml`, `Gemfile`, `go.mod`, `pom.xml`,
  `build.gradle`, Dockerfiles (`FROM`), docker-compose (`image:`), GitHub Actions
  workflows (`setup-*` steps and container images), version pin files (`.nvmrc`,
  `.node-version`, `.python-version`, `.ruby-version`, `.terraform-version`), and
  `.tool-versions`/`mise.toml`.
- **FR-3.2** Product-name aliases map common names to manifest names
  (e.g., `nodejs` ↔ `node`, `postgresql` → `postgres`, `python` → `python3`,
  `golang` ↔ `go`) via `ALIASES` in `server.js`.
- **FR-3.3** Only the repository's default branch is scanned.
- **FR-3.4** Only `.yml`/`.yaml` files under `.github/workflows` (and the known CI config
  filenames) are treated as workflows. Repos keep scratch files such as
  `Android-Deploy-Dev-Internal-devapp.txt` next to their workflows, and those are not
  parsed as YAML.
- **FR-3.5** A `setup-*` workflow step only contributes a version when the product being
  scanned is the one that step installs (`SETUP_PRODUCTS` in `server.js`). `setup-dotnet`
  cannot report a Node version, and `setup-node` cannot report a Python version. Any
  other `setup-*` step clears the pending input.
- **FR-3.6** Per-repo file counts are bounded by `MAX_WORKFLOWS_PER_REPO`,
  `MAX_DOCKERFILES_PER_REPO` and `MAX_FILES_PER_REPO`, all **0 (uncapped) by default**.
  Whenever a cap skips a file, the skipped paths are listed in `errors`; reaching a cap
  never silently reduces coverage. Contents are fetched with bounded concurrency
  (`FILE_CONCURRENCY`, default 8).
- **FR-3.7** File contents larger than `MAX_FILE_BYTES` (default 200 KB) are skipped,
  and a file that cannot be read (404, rate limit, no contents access) is reported in
  `errors` as `Could not read <path>: <reason>`.
- **FR-3.8** A file tree that GitHub returns as `truncated` is reported as an incomplete
  tree rather than treated as a complete one.

### FR-4 EOL resolution and status
- **FR-4.1** A detected version is resolved against the product's `endoflife.date` cycles
  by comparing **dotted components**: a cycle matches when it is a component-wise prefix
  of the version, and the longest matching cycle wins. `24.15.0` → cycle `24`,
  `3.10.4` → cycle `3.10` (not cycle `3`, and never cycle `3.14`), `1.25` never matches
  cycle `12`. Digit-stripped prefix matching is not used.
- **FR-4.2** Status determination:
  - `active` — cycle not past its EOL date;
  - `warning` — support-period expired but EOL not reached;
  - `eol` — past EOL (or boolean EOL);
  - `unknown` — version does not resolve to a known cycle;
  - `error` — the EOL data could not be read (surfaced in the row's `error`).
- **FR-4.3** Boolean `eol`/`support` values mean different things per field and are
  labelled as such, never as one shared pair of words:
  `eol: true` → "EOL (no date)", `eol: false` → "Not announced",
  `support: true` → "Supported (no end date)", `support: false` → "Ended (no date)".
- **FR-4.4** A spec carrying a range operator (caret, tilde, comparator, wildcard, union,
  hyphen range) is a **constraint**, not the version in use. Rows are tagged
  `detection: pinned|constraint` with `confidence: High|Medium`, the raw spec is kept
  alongside the extracted version, and constraint rows are excluded from the EOL counts
  in the scan summary (a repository whose only evidence is a range is reported as
  "constraint only").
- **FR-4.5** EOL lookups are cached in memory keyed by product+version for
  `EOL_CACHE_TTL_MS` (default 24 hours). Failed lookups and unknown products are cached
  for only `EOL_ERROR_TTL_MS` (default 5 minutes), so a transient outage does not become
  a permanent answer.

### FR-5 Functional domain mapping
- **FR-5.1** Each scanned repository is classified into a functional domain from an
  editable data file (`domains.json`).
- **FR-5.2** `domains.json` holds two **exact-keyed** tables: `repos` (repo name →
  `{ region, category }`) and `teams` (GitHub team slug → `{ region, category }`), the
  latter holding the Compass taxonomy (region: Mastery Central, Mastery West, Mastery
  International, IT Ops, Applied Technology; category: Alchemy, Core Load, Load
  Execution, Back Office & Accounting, Asset Resources, EDI).
- **FR-5.3** Resolution: a `repos` override wins, then the repository's owning GitHub
  team's entry. **Substring rules are not used** — they matched the org prefix and
  mid-word fragments, filing `mastery-credit` under EDI ("edi" in "credit") and
  `mass-uploads-library` under Load Status ("load" in "upload").
- **FR-5.4** A repository with no mapping is reported as **"Unmapped"**, never as a blank
  cell or a homepage hostname. The homepage hostname is still available as a tooltip.
- **FR-5.5** `npm run domains:seed <org>` prints the org's team slugs with empty
  region/category to fill in, plus the repositories still Unmapped afterwards.

### FR-6 Web interface
- **FR-6.1** Single-page UI with a text area for the software list and an organization
  input (pre-filled from server configuration).
- **FR-6.2** Two actions: **Check EOL** (direct lookup) and **Scan org repos** (org scan).
  The org scan shows live progress and renders the stored result.
- **FR-6.3** Org scan results are displayed in a **paginated** (50 rows per page) and
  filterable table with columns: Repository, Region, Domain, Software, Detected as, Used
  version, Detection, File:line, Evidence, Cycle, Latest, EOL, Support until, Source API,
  Last deploy run, Repo status, Status. Results are filterable by status and by
  detection (pinned / ranges).
- **FR-6.4** A repo-level rollup is shown above the table: repositories by worst status
  and repositories by domain (with the count that have an EOL version).
- **FR-6.5** All user-provided values and error messages are HTML-escaped to prevent XSS.
  This includes every dynamic string, including `cycle` and `latest`.
- **FR-6.6** The CSV export includes the matched source line (`Evidence`), the line
  number, the manifest name (`Detected as`), the raw spec, detection and confidence, the
  region, the repository's worst status, and the reason behind any empty last-deploy cell.
  A second export writes version-shaped columns as text (`="3.10"`) so Excel does not
  read `3.10` as `3.1`; a third export writes the per-repository and per-domain rollups.
- **FR-6.7** The status line reports **repositories**, not rows: how many repositories
  were scanned out of how many listed, how many repositories have matches, and how many
  repositories are EOL.

## 7. API Requirements

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/api/products` | — | Product catalog from endoflife.date. |
| GET | `/api/org` | — | Configured organization, allowed organizations, credential type, active file limits. |
| GET | `/api/health` | — | Liveness plus the last observed GitHub rate limit. |
| POST | `/api/eol` | `{ products: string[] }` | Per-product EOL summary. |
| POST | `/api/org-scan` | `{ owner, products, limit? }` | `202` with the scan job id and its initial state. |
| GET | `/api/org-scan/jobs` | — | Stored scan jobs, newest first. |
| GET | `/api/org-scan/jobs/{id}` | — | Job state, progress and (when finished) the stored scan result. |
| GET | `/api/org-scan/latest` | `?owner=` | The most recent completed scan for an org, with its `finishedAt` timestamp. |
| Any | `/api/*` (unmatched) | — | JSON 404 `{ error }`. |

## 8. Non-Functional Requirements

- **NFR-1 Performance:** A full scan covers ~1,000 active repositories and thousands of
  API calls, so it runs as a background job with progress rather than inside one request:
  a synchronous full-org response is cut off by typical reverse-proxy timeouts (~60s).
  Per repository, file contents are fetched with bounded concurrency; per-repo file
  counts are uncapped by default and configurable when the GitHub request budget is the
  binding constraint. EOL and Actions lookups are TTL-cached.
- **NFR-2 Security:**
  - Credentials (`GITHUB_TOKEN` or `GITHUB_APP_*`) live only in a local `.env` file that
    is excluded from version control. A GitHub App installation token is preferred over a
    personal access token.
  - No secrets are logged or exposed via any API response.
  - The server binds to `127.0.0.1` by default; `HOST` must be set explicitly to expose
    it, and a shared deployment must put company SSO in front of it.
  - Scans are restricted to `GITHUB_ORG` plus `SCAN_ALLOWED_ORGS`, so a caller cannot
    make the token read any other organization.
  - XSS: all dynamic UI strings are escaped.
- **NFR-3 Privacy:** Private repositories are only accessible with the configured token;
  content is fetched only for manifest/configuration files in the default branch.
- **NFR-4 Reliability:** GitHub API failures on individual repos are isolated and reported
  per-repo; `endoflife.date` failures surface as clear error messages.
- **NFR-5 Maintainability:** Detection and domain-mapping logic is centralized and data
  driven (`ALIASES`, `domains.json`), so new software/languages can be added without UI changes.

## 9. Solution Design

### 9.1 Architecture Overview

The solution is a single Node.js/Express process that serves both the REST API and the
static single-page frontend (no build step, no database).

```
                  +---------------------------+
    Browser  ---> |  Express server (server.js)|
  (SPA: public/)  +------+-----------|---------+
                        |           |
            endoflife.date   GitHub REST API + raw.githubusercontent.com
                       (EOL data)     (org repos, file trees, file contents)
```

| Component | Responsibility |
| --- | --- |
| `server.js` | REST API (`/api/*`), static hosting, GitHub + EOL HTTP clients, detection pipeline, domain mapping, caching, scan jobs. |
| `public/` (index.html, app.js, style.css) | Single-page UI: input, direct EOL checks, org scans with progress, rendering/filtering/pagination, CSV exports. |
| `domains.json` | Data-driven repo → domain rules and team → Compass taxonomy (editable without code changes). |
| `scripts/seed-domains.js` | Prints the team slugs and unmapped repos to fill into `domains.json`. |
| `test/` (`detect.test.js`, `scan.test.js`) | `node:test` regression tests for the detection, cycle, domain, deploy-run and scan-count logic. |
| `.env` | Local secrets/config; excluded from version control; loaded by a tiny loader in `server.js` (real env vars take precedence). |

### 9.2 Tech Stack

- **Runtime:** Node.js ≥ 18 (uses native `fetch`, no HTTP client dependency)
- **Framework:** Express 4
- **Frontend:** Vanilla HTML/CSS/JS (no framework, no build step)
- **External APIs:** `endoflife.date` (EOL data), GitHub REST API v3 (org/repos/trees),
  `raw.githubusercontent.com` (file contents)
- **Config:** environment variables via `.env`

### 9.3 Key Server Components

1. **EOL client** — `fetchJson()` wraps the `endoflife.date` API; 404 → null,
   other errors → typed message.
2. **GitHub client** — `ghFetch()` authenticates with a GitHub App installation token when
   `GITHUB_APP_*` is configured, otherwise with `GITHUB_TOKEN`; 403/429 raise a typed
   rate-limit error carrying the reset time.
3. **Repo lister** — `listOrgRepos()` pages the org repos endpoint until a short page and
   reports whether the ceiling was hit.
4. **Tree walker** — `getRepoTree()` pulls the default-branch recursive git tree and
   reports GitHub's `truncated` flag.
5. **File classifier** — `classifyFile()` maps a path to a manifest type
   (`package-json`, `docker`, `workflow`, pin files, …) or `null` to skip; only YAML files
   under `.github/workflows` classify as workflows.
6. **Candidate selector** — `selectCandidates()` applies the (default uncapped)
   per-repo file limits and returns the skipped paths so nothing is dropped silently.
7. **Raw content fetcher** — `fetchRawFile()` fetches file text with the credential
   (required for private repos) and returns a reason instead of an empty string when the
   read fails.
8. **Version extractor** — `detectInFile()` runs per-file-type extractors against the
   requested product and returns `{ version, spec, raw, line, constraint, detectedAs }`.
9. **Cycle matcher** — `findCycleForVersion()` matches a version to a release cycle by
   comparing dotted components, longest prefix wins.
10. **EOL resolver** — `lookupProductEol()` derives status for a version; cached in memory
    per product+version with a TTL, and failures are cached only briefly.
11. **Domain mapper** — `functionalDomain()` resolves a repo to `{ domain, region,
    domainSource }` from the repo override table or its owning team, else `Unmapped`.
12. **Deploy lookup** — `getLastSuccessfulRun()` / `pickDeployRun()` find the newest
    successful run on the default branch with a deploy-type trigger and always return a
    reason for a blank cell; cached per repo, and never fails the scan.
13. **Scan jobs** — `createScanJob()` runs `scanOrg()` off the request cycle, records
    progress, and retains completed results for `GET /api/org-scan/latest`.

### 9.4 Org Scan Data Flow

1. Client `POST /api/org-scan` with `{ owner, products, limit? }` → `202 { jobId }`.
2. Server rejects an org outside `GITHUB_ORG`/`SCAN_ALLOWED_ORGS` with `403`.
3. Server fetches the EOL product catalog once (`/all.json`).
4. Lists org repositories page by page until a short page, then removes forks and
   archived repos, then applies `limit` to what will actually be scanned.
5. Optionally fetches team → repo slugs (only when `domains.json` declares teams).
6. For each repository:
   a. Fetch the default-branch recursive tree; record a truncated tree.
   b. Select candidate manifest files, recording any skipped by a cap.
   c. Fetch file contents with bounded concurrency, recording each failed read.
   d. Look up the last deploy run for the repo (cached per repo).
   e. Extract versions for every requested product from each candidate file.
7. For each unique product+version, resolve cycle/EOL/status via the cached resolver.
8. Stamp each row with its repository's worst status and return
   `{ owner, counts, rows, errors, summary }`, stored on the job.

### 9.5 API Contract (Org Scan Result)

```json
{
  "owner": "masterysystems",
  "scannedRepos": 998,
  "listedRepos": 1766,
  "forkRepos": 29,
  "archivedRepos": 739,
  "listingTruncated": false,
  "truncatedTrees": 1,
  "failedFetches": 4,
  "skippedFiles": 0,
  "rows": [
    {
      "repo": "masterysystems/mastery-frontend",
      "repoUrl": "https://github.com/masterysystems/mastery-frontend",
      "domain": "Frontend",
      "region": "Mastery Central",
      "domainHost": "masterysys.atlassian.net",
      "domainSource": "repo-override",
      "branch": "main",
      "lastDeployment": { "date": "2026-09-28T14:03:11Z",
                           "name": "Deploy to production",
                           "url": "https://github.com/masterysystems/mastery-frontend/actions/runs/123",
                           "branch": "main",
                           "event": "push",
                           "reason": null,
                           "scope": "newest successful run on the default branch with a push/workflow_dispatch/release trigger" },
      "name": "nodejs",
      "detectedAs": "node",
      "file": "plugins/custom-eslint/package.json",
      "line": 3,
      "version": "8.0.0",
      "versionSpec": ">=8.0.0",
      "versionRaw": "\"node\": \">=8.0.0\"",
      "detection": "constraint",
      "confidence": "Medium",
      "repoStatus": "active",
      "eol": { "status": "unknown", "cycle": null, "latest": null,
               "eol": null, "support": null, "isLts": false }
    }
  ],
  "errors": [{ "repo": "masterysystems/some-repo", "message": "GitHub API error 403" }],
  "summary": {
    "scannedRepos": 998,
    "listedRepos": 1766,
    "reposWithMatches": 119,
    "rows": 379,
    "pinnedRows": 129,
    "constraintRows": 250,
    "reposByStatus": { "eol": 0, "warning": 12, "active": 60, "unknown": 0, "constraintsOnly": 47 },
    "reposByDomain": [{ "domain": "Frontend", "repos": 12, "eol": 2 }],
    "coverage": { "truncatedTrees": 1, "failedFetches": 4, "skippedFiles": 0 }
  }
}
```

### 9.6 Version Detection Pipeline

```
file path ──classifyFile──> manifest type
                                │
 requested product ──productVariants──> name variant set (aliases applied)
                                │
 detectInFile(type, content, variants) ──> [{ version, spec, raw, line,
                                                 constraint, detectedAs }, ...]
                                │
 isConstraintSpec(spec) ──> pinned (High) | constraint (Medium)
                                │
 normVersion(spec) ──> canonical numeric version (e.g. "^18.0.0" → "18.0.0")
                                │
 findCycleForVersion(cycles, version) ──> cycle, by dotted component prefix
```

- Each file type has a dedicated extractor (JSON maps, `==` constraints, `FROM`/`image:`
  lines, workflow `setup-*` steps, tool-versions lines, …).
- Workflow `setup-*` extraction only fires when the setup step installs the product being
  scanned (`SETUP_PRODUCTS`), so another language's toolchain cannot be reported.
- Version→cycle resolution compares dotted components, so `24.15.0` resolves to cycle
  `24` and `1.25` can never resolve to cycle `12`.

### 9.7 Functional Domain Mapping

`domains.json` holds two exact-keyed tables, `repos` and `teams`.
`functionalDomain(repo, teamSlugs)`:

1. Exact repository-name match in `repos` → `{ region, category }`.
2. Else the repository's owning GitHub team slug, matched in `teams` → `{ region, category }`.
3. Else `Unmapped`.

There are no substring rules: they also matched the org prefix, so `full_name` took part
in every match. `mastery-credit` was filed under EDI because "edi" is inside "credit", and
`mass-uploads-library` / `capacity-load-testing` under Load Status because "load" is
inside "upload" / "load" — while 54 repositories matched nothing at all.

Adding a rule is a data-only change; no code or UI changes required. Run
`npm run domains:seed <org>` to list the org's team slugs (with empty region/category to
fill in) and the repositories that are still `Unmapped` afterwards.

### 9.8 Security Design

- The GitHub credential (GitHub App installation token, else `GITHUB_TOKEN`) is read from
  `.env`/environment only; never logged or returned by APIs.
- Private-repo content fetching uses that credential on `raw.githubusercontent.com`.
- The server binds to `127.0.0.1` unless `HOST` is set, and scans are restricted to
  `GITHUB_ORG` + `SCAN_ALLOWED_ORGS`. Exposing it on a shared host requires putting
  company SSO in front of it — the app itself has no authentication.
- All dynamic UI output is HTML-escaped to prevent XSS.
- No database; no user input is persisted.
- Unmatched `/api/*` routes return JSON 404 (never HTML), and clients defensively parse
  responses to avoid JSON-parse errors from proxied/HTML pages.

### 9.9 Error Handling & Resilience

- Per-repository failures are captured in the `errors` array; one bad repo does not abort
  the scan. A GitHub rate limit (403/429) stops the repo loop and is reported with the
  reset time rather than burning the remaining quota on failing calls.
- Anything that reduces coverage is reported: truncated trees, unreadable files, files
  skipped by a cap.
- `endoflife.date` and GitHub failures surface as `502`/`400` with a clear JSON message.
  A row whose EOL data cannot be read reports status `error` with the reason, and that
  failure is re-read after `EOL_ERROR_TTL_MS` instead of being cached for a day.
- Unsupported versions report status `unknown` (not a hard failure).

### 9.10 Performance Considerations

- EOL lookups are cached in-process per product+version for a day; Actions lookups per
  repo for an hour. The product catalog is cached for a day.
- Manifest candidates are uncapped by default; contents are fetched with bounded
  concurrency within a repo. `MAX_WORKFLOWS_PER_REPO`, `MAX_DOCKERFILES_PER_REPO` and
  `MAX_FILES_PER_REPO` bound the request budget when needed, and report what they skipped.
- Scans run as background jobs with progress and stored results, so a full-org run
  (masterysystems: 1,766 repositories, 998 active) survives an HTTP timeout and its
  result can be served again later by `GET /api/org-scan/latest`.
- `limit` bounds the number of repositories scanned, for quick spot checks.

### 9.11 Extensibility Points

- New version sources: add a file type + extractor in `detectInFile`/`classifyFile`.
- New product name aliases: extend `ALIASES` in `server.js`.
- New setup actions: extend `SETUP_LANG`/`SETUP_PRODUCTS`/`SETUP_INPUT` in `server.js`.
- New domains: edit `domains.json`.
- Future integrations (e.g., SonarQube, scheduled scans, alerting) build on the stored
  scan results and slot in as additional `/api/*` endpoints without affecting the core
  scan pipeline.

## 10. Configuration

Configured via environment variables, loaded from `.env` (not committed to git):

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_ORG` | — | Default organization for org scans (e.g., `masterysystems`); also the allow-list. |
| `SCAN_ALLOWED_ORGS` | — | Comma-separated extra orgs a caller may scan. |
| `GITHUB_TOKEN` | — | Fine-grained PAT with `contents: read`; `actions: read` is needed for the Last deploy run column. Fallback credential. |
| `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` / `GITHUB_APP_PRIVATE_KEY` | — | GitHub App installation token (preferred). All three are required; `PRIVATE_KEY` may be a PEM with literal `\n`. |
| `HOST` | `127.0.0.1` | Listen address. Set explicitly (and put SSO in front) to share the server. |
| `PORT` | `3000` | HTTP listen port. |
| `MAX_REPO_PAGES` | `200` | Safety ceiling on repository pages (100 per page). Hitting it fails the scan. |
| `MAX_WORKFLOWS_PER_REPO` / `MAX_DOCKERFILES_PER_REPO` / `MAX_FILES_PER_REPO` | `0` (uncapped) | Per-repo file limits; 0 means no cap. Skipped files are always reported. |
| `MAX_FILE_BYTES` | `200000` | Skip file contents larger than this. |
| `FILE_CONCURRENCY` | `8` | Concurrent file fetches within a repository. |
| `EOL_CACHE_TTL_MS` / `EOL_ERROR_TTL_MS` / `CATALOG_CACHE_TTL_MS` | `86400000` / `300000` / `86400000` | Cache lifetimes. |
| `RUN_CACHE_TTL_MS` / `RUN_PAGE_SIZE` / `RUN_MAX_PAGES` | `3600000` / `50` / `3` | Actions lookup cache and how many runs deep to look for a deploy run. |
| `JOB_TTL_MS` / `MAX_JOBS` | `21600000` / `20` | How long scan results are retained and how many jobs are kept. |

## 11. Acceptance Criteria

1. Entering `nodejs, python, postgresql` and running **Check EOL** returns a row per product
   with current version, EOL date, and correct status badge.
2. Running **Scan org repos** against `masterysystems` starts a job that reports progress
   and lists the non-fork/archived repositories that use the entered software, with the
   detected version, file:line, evidence, cycle, EOL and status.
3. A `.nvmrc` containing `24.15` resolves to the `24` cycle and reports an accurate status.
4. A `setup-dotnet 8.0.x` step produces no Node rows, and a `setup-node 20` step produces
   no Python rows.
5. `"node": ">=8.0.0"` in `package.json` is reported as a range with Medium confidence, and
   is excluded from the EOL counts in the scan summary.
6. A full scan of `masterysystems` lists all 1,766 repositories and scans all 998 active
   ones, with the counts reported alongside the results.
7. Forked and archived repos do not appear in results.
8. Repos with no mapping show **Unmapped**; repos in `domains.json` (or owned by a mapped
   team) show their domain. Repos like `mastery-frontend` resolve to **Frontend**;
   `mastery-credit` and `mass-uploads-library` do **not** resolve by substring.
9. Every skipped file, unreadable file and truncated tree appears in `errors`; a failing
   repo does not fail other repos.
10. The status line counts repositories, not rows, and the rollup export lists repositories
    by worst status and by domain.
11. `.env` and `node_modules/` are absent from the git repository.
12. A scan limited by `limit: 40` scans 40 repositories (forks and archived repos excluded
    first).
13. `npm test` passes.

## 12. Future Considerations (Backlog)

- Production deployment dates from Argo CD sync history or the `sha` history of
  `mastermind-release/release/pipeline/prod.json`, rather than the Actions run that
  currently stands in for them.
- An Actions-runtime check for `uses:` references: GitHub removing Node 20 from runners
  applies to JavaScript actions declaring `runs.using: node20`, so a repo can keep
  deploying while still declaring Node 20. The checker measures the Node version an
  application *declares*, not the runtime its actions execute on.
- Scheduled scans with persisted history and email/chat alerting for newly EOL versions.
- Configurable domain mapping via the UI.
- SonarQube quality-gate integration per scanned repository.
- Transitive/pinned (lock-file) dependency analysis.