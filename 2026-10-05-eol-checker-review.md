# EOL Checker — Code and Data Review

Oct 5, 2026 · @Stephen Dishman

The checker's lookup, scan pipeline and per-row source links are a solid base, but its scan results are not yet reliable enough to drive upgrade or archive decisions. In the 2026-10-01 export, 185 of 379 "nodejs" rows are other languages, and the scan reached 392 of the org's 998 active repositories. Fix the first two findings below and regenerate the export before any list built from it is shared; the rest can follow in severity order.

![606 active repos were never scanned; 60 of 119 flagged repos fail verification](2026-10-05-eol-checker-review-funnel.svg)

*GitHub API, 2026-10-05 · 2026-10-01 export checked file by file*

Fixing F2 brings 606 more active repos into the scan; fixing F1 and F4 removes half of today's 119 flagged repos.

## Findings

Two findings are critical: the scan reports other languages' versions as Node.js, and it never sees 606 of the org's 998 active repositories.

| # | Finding | Where | Severity | Status |
| --- | --- | --- | --- | --- |
| F1 | Workflow `setup-*` versions are reported under whatever product was scanned (`setup-dotnet 8.0.x` becomes Node 8) | `server.js` 463–484 | Critical | Not started |
| F2 | Repo listing stops after 10 pages: 1,000 of 1,766 repos are listed, and 606 active repos are never scanned | `server.js` 143–154 | Critical | Not started |
| F3 | "Last deployment" is the newest successful run of any workflow, and the query behind it returns different dates for identical calls | `server.js` 163–193 | High | Not started |
| F4 | Version ranges are reported as the version in use (`"node": ">=8.0.0"` becomes 8.0.0) | `server.js` 286–289, 359–377 | High | Not started |
| F5 | Not ready for a shared server: no access control, caller-chosen org, personal token, one long request, caches that never expire | `server.js` 161, 489, 629–733 | High | Not started |
| F6 | Versions are matched to release cycles by digit-stripped prefix (Go `1.25` lands on Node cycle 12) | `server.js` 72–74, 112–124 | Medium | Not started |
| F7 | Per-repo file caps and failed file fetches drop results without any signal | `server.js` 205–213, 673–698 | Medium | Not started |
| F8 | True/false EOL and support values share one label set: not-EOL shows "Ended", still-supported shows "Stale" | `public/app.js` 90–96 | Medium | Not started |
| F9 | Export omits the matched line, and Excel turns `3.10` into 3.1 | `public/app.js` 233–272 | Medium | Not started |
| F10 | Domain rules leave 54 of 119 repos unmapped and misfile others by substring | `domains.json`, `server.js` 313–323 | Medium | Not started |
| F11 | The status line counts rows, not repositories (379 rows = 119 repos) | `public/app.js` 161–167 | Low | Not started |
| F12 | REQUIREMENTS.md misstates the org's size and makeup and some delivered behavior | `REQUIREMENTS.md` | Low | Not started |

Line numbers refer to commit 9f04184 on main. The 2026-10-01 export's 379 rows were re-checked against the files they cite on each repo's default branch, and the org inventory and Actions data were read from the GitHub API on 2026-10-05.

An existing report already takes the approach several of these fixes point to: the Mastermind Production EOL Report of 2026-09-09 (`Mastermind_Production_EOL_Report_2026-09-09.xlsx`; ask @Stephen Dishman for a copy). It scans every component in `prod.json` at its pinned production commit and matches release cycles by major or major.minor (F6). Each match records its file, line and a High or Medium confidence (F4, F9), and its production-only scope makes a useful second view beside the org-wide scan.

## Detection accuracy

Only 129 of the 379 "nodejs" rows in the 2026-10-01 export are real Node.js versions; the rest come from F1 and F4, and F6 then puts many of them on the wrong release cycle.

| What the row actually is | Rows | Example (repo · file · line found) |
| --- | --- | --- |
| Another language's setup step (F1): 120 .NET, 30 Python, 18 Java, 12 Go, 5 Ruby | 185 | mastery-edi-integration · `codeql-csharp.yml` · `dotnet-version: '8.0.x'`, reported as Node 8 |
| `package.json` lower bound only (F4) | 65 | mastery-frontend · `plugins/custom-eslint/package.json` · `"node": ">=8.0.0"`, reported as 8.0.0 |
| Real Node.js version (`setup-node`, node images, `.nvmrc`, `.tool-versions`, Dockerfile, pinned `package.json`) | 129 | apollo-federation · `.tool-versions` · `nodejs 18.17.0` |

54 of the export's 119 repos appear only because of other-language rows. Ten of the .NET rows have since moved to .NET 10, which the current code would report as Node 10.

Repo-by-repo verdicts for all 119 repos: [Appendix: Export verification](#appendix-export-verification)

**F1 — other languages' setup steps.** The workflow extractor remembers the language of any `setup-*` step but never compares it with the product being scanned, so every `*-version:` input is emitted. More examples: mastermind-argo `actionlint.yaml` (`go-version: 1.25`) becomes Node 12; driver-mobile-app `Android-Deploy-Prod.yaml` (`ruby-version: 3.3.5`, `java-version: "17"`) becomes Node 3 and Node 17. It also runs in reverse: scanning `python` reports `node-version: 24` as Python 24, and the UI's default four-product list emits every setup version four times.

Suggested fix, tested against the cases above (other languages drop out, `setup-node` still matches, and an unrelated `setup-*` step now clears the pending input):

```js
const SETUP_PRODUCTS = {
  node: ["node", "nodejs"], python: ["python", "python3"], golang: ["go", "golang"],
  java: ["java"], ruby: ["ruby"], dotnet: ["dotnet"], php: ["php"],
};

// detectInFile(), workflow branch — replaces `if (lang && SETUP_LANG[lang]) pending = SETUP_LANG[lang];`
const setup = lang && SETUP_LANG[lang];
pending = setup && SETUP_PRODUCTS[setup].some((n) => variants.has(n)) ? setup : null;
```

**F4 — ranges read as versions.** `normVersion()` keeps the first number in a spec, so `>=8.0.0` becomes 8.0.0 and `^16 || ^18 || ^20 || >=22` becomes 16. `engines` and `peerDependencies` say what a package accepts, not what runs. Keep the raw spec, tag each row as pinned or constraint, and leave lower-bound-only constraints out of EOL counts or label them separately.

**F6 — cycle matching.** `cycleKey()` strips the dots before matching, so `1.25` becomes `125` and lands on Node cycle 12, and `3.10` becomes `310` and lands on cycle 3. A Python `3.1.4` would exact-match cycle 3.14. Compare dotted components instead: major only for products whose cycles are majors, major.minor where cycles carry a minor.

**Scope.** The checker measures the Node version an application declares. GitHub's removal of Node 20 from Actions runners (September 23, 2026) applies to JavaScript actions that declare `runs.using: node20`, so a repo can keep deploying while it still declares Node 20 or older. Actions readiness needs its own check of `uses:` references.

## Coverage

The scan reads 392 of the org's 998 active repositories, and within those it skips files without saying so.

**F2 — repo listing cap.** `listOrgRepos()` stops after 10 pages of 100. The org has 1,766 repositories: 998 active, 739 archived and 29 forks. The first 1,000 listed hold 392 active repos; the other 606 active repos, all created since 2023, are never listed, and none of them appear in the export. `limit` is also applied before forks and archived repos are removed, so `limit: 40` can scan fewer than 40 repos.

Fix: keep paging until a short page (or follow the `Link` header) with no fixed cap, and return listed, archived, fork and scanned counts with every scan.

**F7 — silent per-repo limits.** Each repo reads at most 5 workflow files, 3 Dockerfiles and 25 candidate files in total, in tree order. Reaching 25 `break`s the loop, so later workflows and Dockerfiles are skipped too. Across the export's 119 repos:

- 66 repos have more than 5 workflow files, so 667 workflow files were never read
- 33 repos have more than 3 Dockerfiles
- 2 repos exceed the 25-file cap, leaving 700+ manifests unread
- 1 repo's tree comes back truncated, which `getRepoTree()` doesn't check
- 7 non-YAML files under `.github/workflows` (for example `Android-Deploy-Dev-Internal-devapp.txt`) are parsed as workflows

`fetchRawFile()` also returns an empty string on any failed fetch (rate limit, 404, auth), so the file is dropped with no entry in `errors`. Counts above are from each repo's current default branch.

Fix: remove the caps or make them configurable, record skipped files, failed fetches and truncated trees per repo in `errors`, and treat only `.yml`/`.yaml` files as workflows.

## Last deployment

The column shows the newest successful GitHub Actions run of any workflow, and the query behind it is unstable, so it can't stand in for a deployment date (F3).

**What it measures.** `getLastSuccessfulRun()` takes the first result of `/actions/runs?status=success&per_page=1`: any workflow, any branch, any trigger, including scheduled jobs and pull-request checks. Production deploys run through Argo CD (`mastermind-argo`: "component charts and info for argo deployments") from the release manifest `mastermind-release/release/pipeline/prod.json`, which pins 846 components from 324 repos to a commit SHA. In `configuration`, every recent successful run is a scheduled job that fires many times a day, and there is no successful push-triggered run on `main` at all.

**Unstable results.** For busy repos, GitHub's `status` filter returns partial result sets; `total_count` itself changed from 672 to 2,500 between identical calls. Calls made minutes apart on 2026-10-05:

| Repo | Query | Newest successful run returned |
| --- | --- | --- |
| configuration | `status=success&per_page=1`, three identical calls | 2025-12-19, then 2026-03-13, then 2026-10-05 |
| configuration | `status=success&per_page=4` | 2026-08-23 |
| configuration | `status=success` plus `created>=2026-09-01`, or no `status` filter | 2026-10-05 (correct) |
| noc-mastermind-dashboards | `status=success&per_page=1` | 2026-05-18, a pull-request check |
| noc-mastermind-dashboards | no `status` filter | 2026-10-05 (correct) |

A blank date is ambiguous too: Actions disabled, no successful run, a token without `actions:read`, or an empty filtered result all look the same, and the export doesn't say which.

Fix:

1. Drop the `status` filter (or bound it with `created>=`) and pick the first run with `conclusion == "success"` client-side.
2. Limit it to the default branch and deploy-type triggers (`push`, `workflow_dispatch`, release workflows), or rename the column "Last successful workflow run".
3. For a true production date, use when the component's `sha` last changed in `prod.json` (the file's commit history) or Argo CD's sync history.
4. Export the reason next to any empty value.

## Labels and export

Three presentation issues make correct output easy to misread: true/false values get the wrong words, the export drops the evidence, and the summary counts rows as if they were repos.

**F8 — true/false values.** endoflife.date uses booleans when no date is published, and their meaning depends on the field. `fmtDate()` maps every `true` to "Stale" and every `false` to "Ended" regardless of column:

| endoflife.date value | Means | Shown today | Suggested label |
| --- | --- | --- | --- |
| `eol: true` | EOL, date not published | Stale | EOL (no date) |
| `eol: false` | Not EOL, no date announced | Ended | Not announced |
| `support: true` | Still supported, no end date | Stale | Supported (no end date) |
| `support: false` | Support ended, date not published | Ended | Ended (no date) |

Redis 8.10, the current release, shows EOL "Ended" and Support "Stale" next to a "Supported" badge. The export's 39 "Ongoing" rows (the label before commit 9f04184) are all Node cycle 3, which only appears through F1's Python and Ruby matches.

**F9 — export.** The CSV leaves out `versionRaw`, the line each version was read from, which is the quickest way to spot a bad match. Excel then reads versions as numbers: `python-version: '3.10.x'` in edi-monitor's `main.yml` shows as 3.1, and `dotnet-version: '8.0.x'` shows as 8. Add Evidence (the matched line), Line, Detected product and Confidence columns; write versions as text (for example `="3.10"`) or offer an XLSX export; and include the reason behind any blank Last deployment.

**F11 — rows vs. repositories.** The status line reads "Scanned N repos, found M software matches", where M counts file-level rows and one repo often has several. The 2026-10-01 export has 379 rows from 119 repos. Most decisions are made per repo, so add a repo-level rollup (repos by worst status, and by domain) to the UI and the export.

## Domain mapping

The rules in `domains.json` describe technical layers rather than Mastery's domains, leave 54 of the export's 119 repos unmapped, and misfile others by substring (F10).

The 54 unmapped repos include alchemy-abacus, alchemy-lane, alchemy-routing-guide, alchemy-spot-quote, alchemy-tendering, master-bid, customer-commitments, qualified-carriers and tendering-email-service. They show a blank domain, or the repo's homepage hostname when one is set. Substring matches assign others to the wrong domain:

| Repo | Rule that fired | Domain assigned |
| --- | --- | --- |
| mastery-credit | `edi` (in "credit") | EDI / Integrations |
| mass-uploads-library, mass-uploads-process-scheduler, data-upload-service, ServiceProfileUpload | `load` (in "upload") | Load Status |
| capacity-load-testing, load-and-performance-tests | `load` | Load Status |
| api-regression-tests, external-api-code-standards | `api` | Backend API |

Rules are also tested against `full_name`, so the org prefix takes part in every substring match.

Fix: adopt Compass's taxonomy — region (Mastery Central, Mastery West, Mastery International, IT Ops, Applied Technology) and category (for example Alchemy, Core Load, Load Execution, Back Office & Accounting, Asset Resources, EDI). Compass's repo links are thin, though: in the GitHub-vs-Compass audit only 77 of 312 services match a GitHub repo, and 16 of the export's 119 repos appear in it. Map through each repo's owning GitHub team (repo → team → Compass region and category), keep an explicit override table for the rest, drop substring rules, and show "Unmapped" rather than a blank or a hostname.

## Before hosting on a shared server

The server is built for one person running it locally; five changes are needed before it runs on a shared host or on a schedule (F5).

| Area | Today | Change |
| --- | --- | --- |
| Access | No authentication on any endpoint, and `app.listen()` binds all interfaces (`server.js` 731) | Put it behind company SSO; bind to localhost for local use |
| Scan target | `owner` comes from the request body, so a caller can scan any org the token can read (`server.js` 629–651) | Restrict scans to the configured `GITHUB_ORG` or an allow-list |
| Credentials | A personal access token in `.env` | A GitHub App installation token with read-only Contents and Actions permissions |
| Execution | One synchronous request walks every repo in sequence and answers only at the end; typical reverse-proxy defaults (around 60 seconds) will cut a full-org scan off | Run scans as background jobs with progress, store each result with a timestamp, and serve the stored result — also the basis for scheduled runs and history |
| Caching | `EOL_CACHE` and `RUN_CACHE` never expire, and failures are cached too (`server.js` 161, 489) | Add TTLs (for example a day for EOL data, one scan for workflow runs) and don't cache errors |

One smaller item: `cycle` and `latest` from endoflife.date are rendered without `escapeHtml()` (`public/app.js` 202–203, 300–301), although FR-6.5 and NFR-2 require every dynamic UI string to be escaped.

## Requirements doc

Six statements in `REQUIREMENTS.md` no longer match the code or the org; update them alongside the fixes so the doc stays the reference (F12).

| REQUIREMENTS.md says | Actual |
| --- | --- |
| §9.10: masterysystems has "1000+ repositories, mostly forks which are skipped" | 1,766 repos: 998 active, 739 archived, 29 forks |
| NFR-1 sizes the scan for "a \~50 repo org"; the §9.5 example shows `scannedRepos: 53` | About 1,000 active repos to scan once F2 is fixed |
| FR-2.2: the scan "iterates all non-fork, non-archived repositories" | Only repos in the first 1,000 listed are scanned (F2) |
| FR-2.7: Last deployment is "the most recent successful GitHub Actions workflow run" | True to the code, but any workflow, branch or trigger counts, and the query is unstable (F3) |
| FR-6.3: a "paginated/filterable table" with ten columns | No pagination; the table has twelve columns, including Source API and Last deployment |
| Acceptance criterion 4: "0 unmapped in a full scan" | 54 of the export's 119 repos are unmapped (F10) |

---

## Appendix: Export verification

Every row of the 2026-10-01 export (`eol-org-scan-masterysystems-2026-10-01-17-00-29.csv`) was checked against the file it cites: drop 54 repos, review 6, keep 59.

Other-language rows are versions read from `setup-dotnet`, `setup-python`, `setup-java`, `setup-go` and `setup-ruby` steps (F1). Range-only rows are `package.json` lower bounds such as `">=8.0.0"` (F4); Review means a repo's only Node evidence is one of those. The ten .NET rows in alchemy-carrier-capacity, alchemy-tendering and tendering-email-service have since moved to .NET 10.

### Drop or review

| Repository | Rows | Real Node.js versions | Other-language rows | Range-only rows | Verdict |
| --- | --- | --- | --- | --- | --- |
| aardwolf-shared | 2 | — | 2 .NET | — | Drop |
| accounting-voucher-service | 4 | — | 4 .NET | — | Drop |
| alchemy-abacus | 4 | — | 4 .NET | — | Drop |
| alchemy-accessorial | 4 | — | 4 .NET | — | Drop |
| alchemy-carrier-capacity | 2 | — | 2 .NET | — | Drop |
| alchemy-pattern | 2 | — | 2 .NET | — | Drop |
| alchemy-spot-quote | 2 | — | 2 .NET | — | Drop |
| alchemy-tendering | 5 | — | 5 .NET | — | Drop |
| api-regression-tests | 5 | — | 5 Python | — | Drop |
| blume-integrations | 5 | — | 5 .NET | — | Drop |
| C0-T | 4 | — | 3 .NET, 1 Java | — | Drop |
| common-checks-dotnet | 1 | — | 1 Java | — | Drop |
| customer-commitments | 1 | — | 1 .NET | — | Drop |
| devops-poc-test-workflow | 1 | — | 1 Go | — | Drop |
| driver-android | 3 | — | 3 Java | — | Drop |
| edi-monitor | 1 | — | 1 Python | — | Drop |
| edi-monitor-test | 1 | — | 1 Python | — | Drop |
| eta-calculator-api | 4 | — | 3 .NET, 1 Java | — | Drop |
| flatbed-newrelic-terraform | 1 | — | 1 .NET | — | Drop |
| healthy-hosted-service | 1 | — | 1 .NET | — | Drop |
| jay-repo-test | 3 | — | 3 .NET | — | Drop |
| load-audit-service | 1 | — | 1 .NET | — | Drop |
| ltl-pricing-matrix | 3 | — | 3 .NET | — | Drop |
| mass-uploads-library | 1 | — | 1 .NET | — | Drop |
| master-bid | 4 | — | 4 .NET | — | Drop |
| mastermind-argo | 1 | — | 1 Go | — | Drop |
| mastermind-release | 2 | — | 2 Go | — | Drop |
| mastery-accounting | 1 | — | 1 .NET | — | Drop |
| mastery-charge-type-configuration | 4 | — | 4 .NET | — | Drop |
| mastery-clients-dotnet | 1 | — | 1 .NET | — | Drop |
| mastery-credit | 4 | — | 4 .NET | — | Drop |
| mastery-crm-service | 2 | — | 1 .NET, 1 Java | — | Drop |
| mastery-data-engineering-deployment | 3 | — | 3 Python | — | Drop |
| mastery-edi-integration | 2 | — | 2 .NET | — | Drop |
| mastery-edi-processor | 1 | — | 1 .NET | — | Drop |
| mastery-edi-shared | 2 | — | 2 .NET | — | Drop |
| mastery-enterprise-dotnet | 1 | — | 1 .NET | — | Drop |
| mastery-fuel | 3 | — | 3 .NET | — | Drop |
| mastery-hermes | 1 | — | 1 Python | — | Drop |
| mastery-pse-custom-code | 1 | — | 1 Python | — | Drop |
| mastery-west-dotnet-api-template | 6 | — | 6 .NET | — | Drop |
| mist | 1 | — | 1 .NET | — | Drop |
| noc-mastermind-dashboards | 2 | — | 2 Python | — | Drop |
| postgres-query-monitor | 1 | — | 1 Python | — | Drop |
| procurement-dotnet | 1 | — | 1 .NET | — | Drop |
| security-team | 1 | — | 1 Python | — | Drop |
| ServiceProfileUpload | 4 | — | 3 .NET, 1 Java | — | Drop |
| team-monkey-wrench | 1 | — | 1 Python | — | Drop |
| tendering-email-service | 3 | — | 3 .NET | — | Drop |
| terraform-mastery-cloudflare | 1 | — | 1 Python | — | Drop |
| terraform-mastery-confluentcloud | 1 | — | 1 Python | — | Drop |
| terraform-mastery-subscription-management | 1 | — | 1 Python | — | Drop |
| terraform-provider-kafka-connect | 4 | — | 4 Go | — | Drop |
| terraform-provider-postgresreplication | 1 | — | 1 Go | — | Drop |
| external-api-code-standards | 5 | — | — | 5 | Review |
| external-api-model | 7 | — | — | 7 | Review |
| external-api-tools | 3 | — | — | 3 | Review |
| mastery-frontend | 1 | — | — | 1 | Review |
| mastery-pino-logger | 1 | — | — | 1 | Review |
| regression-tests | 3 | — | 2 Python | 1 | Review |

### Keep

| Repository | Rows | Real Node.js versions | Other-language rows | Range-only rows | Verdict |
| --- | --- | --- | --- | --- | --- |
| 3pi-tracking-macropoint | 1 | 20 | — | — | Keep |
| 3pi-tracking-truckertools-api | 1 | 20 | — | — | Keep |
| alchemy-costquote | 1 | 18 | — | — | Keep |
| alchemy-lane | 9 | 20 | 8 .NET | — | Keep |
| alchemy-routing-guide | 7 | 20 | 6 .NET | — | Keep |
| api-support-tools | 6 | 18.14.0, 18.17.0, 20.11.0 | 1 Python | — | Keep |
| apollo-benchmarks | 1 | 16.15.1 | — | — | Keep |
| apollo-federation | 6 | 18, 18.17.0 | — | — | Keep |
| capacity-load-testing | 2 | 16.16.0 | — | 1 | Keep |
| central-automated-tests | 8 | 16 | 3 Python | — | Keep |
| configuration | 5 | 20.15.0 | 4 Python | — | Keep |
| contacts-v2-consumer | 4 | 10.18.0, 12, 12.18.4 | — | — | Keep |
| core-graphql-complexity | 2 | 18.17.0 | — | 1 | Keep |
| data-exchange-scheduler | 2 | 20 | 1 .NET | — | Keep |
| data-upload-service | 8 | 18 | 4 .NET | 2 | Keep |
| ddt-snapshot | 1 | 20 | — | — | Keep |
| document-storage-azure-blob | 5 | 16, 16.16.0 | — | 1 | Keep |
| document-storage-db | 24 | 10, 16, 16.16.0 | — | 19 | Keep |
| domino | 1 | 16 | — | — | Keep |
| driver-mobile-app | 11 | 18.9.0 | 5 Ruby, 5 Java | — | Keep |
| external-api-utils | 14 | 18.20.5 | — | 13 | Keep |
| flatfile-service | 7 | 18 | 4 .NET, 1 Java | 1 | Keep |
| github-commit\_analyser | 1 | 14 | — | — | Keep |
| graph-test-api | 1 | 18.16.1 | — | — | Keep |
| graph-utils | 1 | 16 | — | — | Keep |
| helios-dependency-graph-poc | 1 | 18 | — | — | Keep |
| international-performance-tests | 1 | 16.17.0 | — | — | Keep |
| konductor | 3 | 18 | 2 Go | — | Keep |
| lachesis-fastify-newrelic-plugin | 5 | 18, 18.0.0 | — | 1 | Keep |
| load-and-performance-tests | 1 | 20.12.2 | — | — | Keep |
| loadex-automated-testing | 2 | 16 | — | — | Keep |
| loadex-nestjs-template | 1 | 20 | — | — | Keep |
| loadex-zx | 6 | 14, 20 | — | — | Keep |
| mass-uploads-process-scheduler | 7 | 18 | 4 .NET, 1 Java | 1 | Keep |
| mastermind-secrets | 1 | 18 | — | — | Keep |
| mastery-carrierrisk-integration-service | 3 | 18 | 1 .NET, 1 Java | — | Keep |
| mastery-client-credentials | 6 | 18, 18.16.0 | — | 1 | Keep |
| mastery-e2e | 2 | 16.17.0 | — | — | Keep |
| mastery-edi-message-store | 3 | 20 | 2 .NET | — | Keep |
| mastery-egress-invoice-consumer | 5 | 18, 18.14.0 | — | 1 | Keep |
| mastery-graphql-client | 2 | 18.16.0 | — | 1 | Keep |
| mastery-regions-v2-service | 6 | 12 | 4 .NET, 1 Java | — | Keep |
| out-of-route | 1 | 20 | — | — | Keep |
| POC-WAVE-FE | 2 | 14, 14.17.6 | — | — | Keep |
| project-opaque | 4 | 18, 18.14.0 | — | — | Keep |
| qualified-carriers | 2 | 20.19.0 | — | 1 | Keep |
| ramrod-data-dictionary-client | 3 | 18, 18.16.1 | — | 1 | Keep |
| release-train-app | 2 | 18 | 1 Go | — | Keep |
| repo\_stats | 1 | 16.8.0 | — | — | Keep |
| retry-service | 7 | 20, 20.19.0 | — | — | Keep |
| rm-performance-tests | 5 | 14, 14.19.0 | — | — | Keep |
| rmis-integration-service | 3 | 18 | 1 .NET, 1 Java | — | Keep |
| schema-registry-ui | 3 | 20, 20.9.0 | — | 1 | Keep |
| slack-sync-service | 1 | 16 | — | — | Keep |
| thundercats-kafka-producer | 8 | 12, 20, 20.11.1 | — | 1 | Keep |
| thundercats-utils | 6 | 10.18.0, 12, 12.18.4 | — | — | Keep |
| tinkering-dev-mono | 2 | 18.14.0, 20 | — | — | Keep |
| tracking | 1 | 20 | — | — | Keep |
| tracking-eta | 2 | 18.16.1, 20 | — | — | Keep |

---

*Exported 2026-10-05 from the live doc: [EOL Checker — Code and Data Review](https://claude.ai/artifact/2DVhYaAhkDYHWoJJfMEqrt).*
