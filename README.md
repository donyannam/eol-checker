# Software EOL Checker

Finds end-of-life dates for the software your GitHub org actually depends on, by
scanning repositories for the versions they declare and resolving them against
[endoflife.date](https://endoflife.date).

## Requirements

- Node.js 18+ (uses the built-in `fetch`)
- A GitHub credential: a GitHub App installation token (preferred) or a
  fine-grained personal access token

## Setup

```bash
npm install
```

Create a `.env` file (gitignored):

| Variable | Required | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | unless a GitHub App is configured | Fine-grained PAT used for all GitHub API and raw-file requests |
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` | optional | GitHub App installation token; takes precedence over `GITHUB_TOKEN`. In the PEM, newlines can be written as literal `\n`. |
| `GITHUB_ORG` | no | Default organization pre-filled in the UI, and the first entry in the scan allow-list |
| `SCAN_ALLOWED_ORGS` | no | Comma-separated extra organizations a caller may scan |
| `PORT` | no | Listen port (default `3000`) |
| `HOST` | no | Listen address (default `127.0.0.1`) |

### Credential permissions

| Permission | Why |
| --- | --- |
| Contents: read | List org repos, read trees, fetch manifest files (required for private repos) |
| Actions: read | Powers the **Last deploy run** column |
| Metadata: read | Included automatically; used for team lookups when `domains.json` maps teams |

Without **Actions: read** the scan still works, but the Last deploy run column is
blank. Hover the cell to see why — `Actions data unavailable` means the credential
lacked access, which is different from `No successful run`, which means the repo
has no qualifying deploy run.

### Tuning (all optional)

A scan of `masterysystems` lists 1,766 repositories (998 active, 739 archived, 29
forks) and makes thousands of GitHub calls, so it runs as a background job. Most
installations need none of these, but they are available when the request budget is
the binding constraint:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAX_WORKFLOWS_PER_REPO` / `MAX_DOCKERFILES_PER_REPO` / `MAX_FILES_PER_REPO` | `0` (uncapped) | Per-repo file limits. Anything skipped is reported in the scan's errors. |
| `MAX_FILE_BYTES` | `200000` | Skip file contents larger than this. |
| `FILE_CONCURRENCY` | `8` | Concurrent file fetches within a repository. |
| `EOL_CACHE_TTL_MS` / `CATALOG_CACHE_TTL_MS` | `86400000` | How long EOL lookups and the product catalog are cached. |
| `EOL_ERROR_TTL_MS` | `300000` | How long a failed EOL lookup is cached before being retried. |
| `RUN_CACHE_TTL_MS` | `3600000` | How long the per-repo Actions lookup is cached. |
| `JOB_TTL_MS` / `MAX_JOBS` | `21600000` / `20` | How long scan results are retained, and how many jobs are kept. |

A GitHub App installation token gets 15,000 requests/hour versus 5,000 for a PAT,
which is the difference between a full-org scan finishing on a PAT or not.

## Run

```bash
npm start          # defaults to GITHUB_ORG=masterysystems, PORT=3000
```

Then open http://localhost:3000.

The server binds to `127.0.0.1` and only accepts scans for `GITHUB_ORG` and
`SCAN_ALLOWED_ORGS`. To scan a different org, add it to `SCAN_ALLOWED_ORGS`. To
share the server on a network, set `HOST` and put company SSO in front of it — the
app itself has no authentication.

## Usage

- **Check EOL** — resolves the current release cycle for each product in the
  list (one per line) and reports version, cycle, EOL and support dates.
- **Scan org repos** — starts a background job and reports progress while it walks
  every non-fork, non-archived repo, detecting declared versions in manifests,
  workflows, Dockerfiles and version-pin files. Export the results to CSV when it
  finishes; the result is also re-served by the server for 6 hours.

Both tables label the source of each column: *Source API* links to the exact
endoflife.date endpoint used, and *Last deploy run* links to the GitHub Actions run
it came from.

### Exports

Three buttons are available on a scan result:

- **CSV** — every column, including the matched source line, the line number, the
  manifest name, the raw spec, and the reason behind any blank last-deploy cell.
- **CSV (Excel-safe)** — the same, with version-shaped columns written as text
  (`="3.10"`) so Excel does not read `3.10` as `3.1`.
- **CSV (repo rollup)** — one row per repository with its worst status, plus a
  per-domain summary.

## Functional domains

`domains.json` maps repositories to their Compass region and category using exact
keys only — a `repos` override first, then the repository's owning GitHub team via
the `teams` table. Substring rules are deliberately not used. Anything unmapped is
reported as **Unmapped**, and `npm run domains:seed <org>` prints the team slugs
with empty region/category to fill in, plus the repositories still unmapped
afterwards.

## Notes

- **Ranges are not the version in use.** A spec like `">=8.0.0"` or `"^18"` is
  reported as a range with Medium confidence and excluded from the EOL counts in the
  summary, because a constraint does not say what is installed. Pinned versions
  carry High confidence.
- **Workflow setup steps only count for their own product.** `setup-dotnet` never
  produces a Node version, and `setup-node` never produces a Python version.
- **Versions are matched to cycles by dotted components.** `24.15.0` resolves to
  cycle `24`, `3.10.4` to `3.10`, and `1.25` never resolves to cycle `12`.
- Values of `true` / `false` from endoflife.date are labelled per field
  (`EOL (no date)`, `Supported (no end date)`, …) rather than as one shared pair of
  words.
- **"Last deploy run" is not a production deployment date.** It is the newest
  successful workflow run on the default branch whose trigger is `push`,
  `workflow_dispatch`, `release`, `deployment` or `workflow_run`. A blank cell
  states its reason. Use Argo CD sync history for real production dates.
- **Coverage gaps are reported, not hidden.** Skipped files, unreadable files and
  truncated trees all appear in the scan's errors list.

## Tests

```bash
npm test
```

`node:test` regression tests cover version detection, cycle matching, deploy-run
selection, domain mapping, rollups and org-scan counting against a stubbed GitHub
API (including a 1,000+ repository organization).