# Software EOL Checker

Finds end-of-life dates for the software your GitHub org actually depends on, by
scanning repositories for pinned versions and resolving them against
[endoflife.date](https://endoflife.date).

## Requirements

- Node.js 18+ (uses the built-in `fetch`)
- A GitHub fine-grained personal access token

## Setup

```bash
npm install
```

Create a `.env` file (gitignored):

| Variable | Required | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | yes | Fine-grained PAT used for all GitHub API and raw-file requests |
| `GITHUB_ORG` | no | Default organization pre-filled in the UI |
| `PORT` | no | Listen port (default `3000`) |

### Token permissions

| Permission | Why |
| --- | --- |
| Contents: read | List org repos, read trees, fetch manifest files (required for private repos) |
| Actions: read | Powers the **Last deployment** column |

Without **Actions: read** the scan still works, but the Last deployment column
renders `—`. Hover the cell to see the API error. Granting it requires the
`actions:read` permission on the token; for a classic PAT this is covered by the
`repo` scope.

## Run

```bash
npm start          # defaults to GITHUB_ORG=masterysystems, PORT=3000
```

Then open http://localhost:3000.

To scan a different org, either override the script's env var or type the org
name into the UI field.

## Usage

- **Check EOL** — resolves the current release cycle for each product in the
  list (one per line) and reports version, cycle, EOL and support dates.
- **Scan org repos** — walks every non-fork, non-archived repo, detects pinned
  versions in manifests, workflows, Dockerfiles and version-pin files, then
  reports each match with its EOL status. Export the results to CSV.

Both tables label the source of each column: *Source API* links to the exact
endoflife.date endpoint used, and *Last deployment* links to the GitHub Actions
run it came from.

## Notes

- Values of `true` / `false` from endoflife.date render as **Stale** / **Ended**
  — these indicate the state is known but no date is published.
- Repos with many manifests can make a scan slow; results stream back only when
  the full scan completes.