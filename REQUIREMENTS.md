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

- The GitHub organization is `masterysystems`, whose repositories are **private**.
- Scanning private repositories and reading private file contents requires a GitHub
  personal access token with `contents: read` access to the target repositories.
- The `endoflife.date` public API provides authoritative product, cycle, and EOL data.
- Runtime: Node.js >= 18 (native `fetch`), single dependency `express`.
- No database; all state is ephemeral per request (in-memory EOL cache only).

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
  `GITHUB_ORG`) and a software list, then request an org scan.
- **FR-2.2** The scan iterates all non-fork, non-archived repositories in the organization,
  enumerates the default branch file tree, and reads common manifest/configuration files.
- **FR-2.3** For each entered product, the scan reports per repository/file/version:
  repository name and URL, functional domain, software, detected version, the file where
  the version was found, matching release cycle, latest version, EOL date, support date,
  and status (`Supported` / `Support ended` / `EOL` / `Unknown`).
- **FR-2.4** Forked and archived repositories are excluded from the scan.
- **FR-2.5** Optional `limit` parameter restricts the number of repositories scanned
  (used for large organizations).
- **FR-2.6** Repo-level failures (e.g., inaccessible tree) are reported in an `errors` list
  rather than aborting the whole scan.

### FR-3 Version detection
- **FR-3.1** The scanner detects product versions from the following file types:
  `package.json` (dependencies, devDependencies, engines), `composer.json`,
  `requirements*.txt`, `Pipfile`, `pyproject.toml`, `Gemfile`, `go.mod`, `pom.xml`,
  `build.gradle`, Dockerfiles (`FROM`), docker-compose (`image:`), GitHub Actions workflows
  (`setup-*` steps and container images), version pin files (`.nvmrc`, `.node-version`,
  `.python-version`, `.ruby-version`, `.terraform-version`), and `.tool-versions`/`mise.toml`.
- **FR-3.2** Product-name aliases map common names to manifest names
  (e.g., `nodejs` → `node`, `postgresql` → `postgres`, `python` → `python3`,
  `golang` → `go`) via `ALIASES` in `server.js`.
- **FR-3.3** Only the repository's default branch is scanned.
- **FR-3.4** File contents larger than ~200 KB are skipped to bound request time.

### FR-4 EOL resolution and status
- **FR-4.1** A detected version is resolved against the product's `endoflife.date` cycles;
  patch/minor versions resolve to their major release cycle
  (e.g., `24.15` → cycle `24`).
- **FR-4.2** Status determination:
  - `active` — cycle not past its EOL date;
  - `warning` — support-period expired but EOL not reached;
  - `eol` — past EOL (or boolean EOL);
  - `unknown` — version does not resolve to a known cycle.
- **FR-4.3** EOL lookups are cached in-memory keyed by product+version for the life of the
  process to avoid redundant API calls.

### FR-5 Functional domain mapping
- **FR-5.1** Each scanned repository is classified into a functional domain using an
  editable rules file (`domains.json`).
- **FR-5.2** Matching is: exact repository-name match first, then substring match in file
  order, with `api` as a documented catch-all rule.
- **FR-5.3** When no rule matches, the repository's homepage hostname is shown as the
  domain, and the hostname is always available as a tooltip in the UI.

### FR-6 Web interface
- **FR-6.1** Single-page UI with a text area for the software list and an organization
  input (pre-filled from server configuration).
- **FR-6.2** Two actions: **Check EOL** (direct lookup) and **Scan org repos** (org scan).
- **FR-6.3** Org scan results are displayed in a paginated/filterable table with columns:
  Repository, Domain, Software, Used version, File, Cycle, Latest, EOL, Support until, Status.
- **FR-6.4** Results are filterable by status (`All`, `Supported`, `Support ended`, `EOL`,
  `Unknown`).
- **FR-6.5** All user-provided values and error messages are HTML-escaped to prevent XSS.

## 7. API Requirements

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/api/products` | — | Product catalog from endoflife.date. |
| GET | `/api/org` | — | Configured organization (`GITHUB_ORG`). |
| POST | `/api/eol` | `{ products: string[] }` | Per-product EOL summary. |
| POST | `/api/org-scan` | `{ owner, products, limit? }` | Scan rows, repo errors, scanned count. |
| Any | `/api/*` (unmatched) | — | JSON 404 `{ error }`. |

## 8. Non-Functional Requirements

- **NFR-1 Performance:** A single org scan must complete for a ~50 repo org in a reasonable
  time (target: each repo processed in a few seconds). Results stream back in one response.
- **NFR-2 Security:**
  - Credentials (`GITHUB_TOKEN`, etc.) live only in a local `.env` file that is excluded
    from version control.
  - No secrets are logged or exposed via any API response.
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
| `server.js` | REST API (`/api/*`), static hosting, GitHub + EOL HTTP clients, detection pipeline, domain mapping, caching. |
| `public/` (index.html, app.js, style.css) | Single-page UI: input, direct EOL checks, org scans, results rendering/filtering. |
| `domains.json` | Data-driven repo → functional-domain rules (editable without code changes). |
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
2. **GitHub client** — `ghFetch()` authenticates with `GITHUB_TOKEN` (Bearer) when present.
3. **Repo lister** — `listOrgRepos()` paginates the org repos endpoint (capped).
4. **Tree walker** — `getRepoTree()` pulls the default-branch recursive git tree.
5. **File classifier** — `classifyFile()` maps a path to a manifest type
   (`package-json`, `docker`, `workflow`, pin files, …) or `null` to skip.
6. **Raw content fetcher** — `fetchRawFile()` fetches file text with the token (required
   for private repos); contents > 200 KB are skipped.
7. **Version extractor** — `detectInFile()` runs per-file-type extractors against the
   requested product (using name aliases) and returns normalized versions.
8. **EOL resolver** — `lookupProductEol()` matches a version to a release cycle and derives
   status; results cached in-memory per product+version.
9. **Domain mapper** — `functionalDomain()` resolves a repo to its functional domain.

### 9.4 Org Scan Data Flow

1. Client `POST /api/org-scan` with `{ owner, products, limit? }`.
2. Server fetches the EOL product catalog once (`/all.json`).
3. Lists org repositories (skipping forks/archived).
4. For each repository:
   a. Fetch the default-branch recursive tree.
   b. Select candidate manifest files (workflows/dockers capped, other files capped at 25).
   c. Fetch file contents in parallel.
   d. Extract versions for every requested product from each candidate file.
5. For each unique product+version, resolve cycle/EOL/status via the cached resolver.
6. Return `{ owner, scannedRepos, rows, errors }`.

### 9.5 API Contract (Org Scan Response)

```json
{
  "owner": "masterysystems",
  "scannedRepos": 53,
  "rows": [
    {
      "repo": "masterysystems/mastery-frontend",
      "repoUrl": "https://github.com/masterysystems/mastery-frontend",
      "domain": "Frontend",
      "domainHost": "masterysys.atlassian.net",
      "branch": "master",
      "name": "nodejs",
      "file": ".nvmrc",
      "version": "24.15",
      "versionRaw": "24.15",
      "eol": { "status": "active", "cycle": "24", "latest": "24.21.0",
               "eol": "2028-04-30", "support": "2026-04-30", "isLts": true }
    }
  ],
  "errors": [{ "repo": "masterysystems/some-repo", "message": "GitHub API error 403" }]
}
```

### 9.6 Version Detection Pipeline

```
file path ──classifyFile──> manifest type
                                │
requested product ──productVariants──> name variant set (aliases applied)
                                │
detectInFile(type, content, variants) ──> [{ version, versionRaw }, ...]
                                │
normVersion(raw) ──> canonical numeric version (e.g. "^18.0.0" → "18.0.0")
```

- Each file type has a dedicated extractor (JSON maps, `==` constraints, `FROM`/`image:`
  lines, workflow `setup-*` steps, tool-versions lines, …).
- Version→cycle resolution uses numeric-prefix matching so `24.15` resolves to cycle `24`.

### 9.7 Functional Domain Mapping

`domains.json` holds ordered rules. `functionalDomain(repo)`:

1. Exact match on repository name → domain.
2. Substring match on full repository name → domain (first match in file order).
3. Fallback: homepage hostname (also surfaced as a tooltip regardless).

Adding a rule is a data-only change; no code or UI changes required.

### 9.8 Security Design

- GitHub token is read from `.env`/environment only; never logged or returned by APIs.
- Private-repo content fetching uses the token on `raw.githubusercontent.com`.
- All dynamic UI output is HTML-escaped to prevent XSS.
- No database; no user input is persisted.
- Unmatched `/api/*` routes return JSON 404 (never HTML), and clients defensively parse
  responses to avoid JSON-parse errors from proxied/HTML pages.

### 9.9 Error Handling & Resilience

- Per-repository failures are captured in the `errors` array; one bad repo does not abort
  the scan.
- `endoflife.date` and GitHub failures surface as `502`/`400` with a clear JSON message.
- Unsupported versions report status `unknown` (not a hard failure).

### 9.10 Performance Considerations

- EOL lookups are cached in-process per product+version.
- Manifest candidates are capped per repo; large files are skipped; contents are fetched
  in parallel within a repo.
- `limit` parameter bounds scan size for very large organizations (e.g., masterysystems
  has 1000+ repositories, mostly forks which are skipped).

### 9.11 Extensibility Points

- New version sources: add a file type + extractor in `detectInFile`/`classifyFile`.
- New product name aliases: extend `ALIASES` in `server.js`.
- New domains: edit `domains.json`.
- Future integrations (e.g., SonarQube, exports, scheduled scans) slot in as additional
  `/api/*` endpoints without affecting the core scan pipeline.

## 10. Configuration

Configured via environment variables, loaded from `.env` (not committed to git):

| Variable | Purpose |
| --- | --- |
| `GITHUB_ORG` | Default organization for org scans (e.g., `masterysystems`). |
| `GITHUB_TOKEN` | Fine-grained PAT with read (`contents`) access to target repos. |
| `PORT` | HTTP listen port (default `3000`). |

## 11. Acceptance Criteria

1. Entering `nodejs, python, postgresql` and running **Check EOL** returns a row per product
   with current version, EOL date, and correct status badge.
2. Running **Scan org repos** against `masterysystems` lists non-fork/archived repos that
   use the entered software, showing detected version, file, cycle, EOL, and status.
3. A `.nvmrc` containing `24.15` resolves to the `24` cycle and reports an accurate status.
4. Repos like `mastery-frontend` appear under functional domain **Frontend**; all detected
   repos resolve to a domain (`0` unmapped in a full scan of `masterysystems`).
5. Forked/archived repos do not appear in results.
6. Repo trees that fail to load produce an entry in `errors` without failing other repos.
7. `.env` and `node_modules/` are absent from the git repository.
8. A scan limited by `limit: 40` returns rows only for up to 40 listed repositories.

## 12. Future Considerations (Backlog)

- Coverage reports / CSV or JSON export of scan results.
- Scheduled scans with persisted history and email/chat alerting for newly EOL versions.
- Configurable domain mapping via the UI.
- SonarQube quality-gate integration per scanned repository.
- Transitive/pinned (lock-file) dependency analysis.