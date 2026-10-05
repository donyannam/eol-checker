// End-to-end scan tests against a stubbed GitHub + endoflife.date. These cover
// the findings that only show up in a whole-org run: the repository listing cap
// (F2), the per-repo file caps and reporting (F7), and the counts the scan
// reports back (F11).

const test = require("node:test");
const assert = require("node:assert/strict");

const { scanOrg, selectCandidates } = require("../server.js");

const NODE_CYCLES = [
  { cycle: "18", eol: "2025-04-30", support: "2025-04-30", latest: "18.20.5" },
  { cycle: "20", eol: "2026-04-30", support: "2026-04-30", latest: "20.19.0" },
  { cycle: "22", eol: "2027-04-30", support: "2027-04-30", latest: "22.16.0" },
];

const WORKFLOW_WITH_DOTNET = [
  "name: build",
  "jobs:",
  "  build:",
  "    steps:",
  "      - uses: actions/setup-dotnet@v4",
  "        with:",
  "          dotnet-version: '8.0.x'",
].join("\n");

// A fake GitHub org: `repos` drives the listing, `files` drives the tree.
function fakeGitHub({ repos, files }) {
  const requests = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    requests.push(u);

    if (u.startsWith("https://endoflife.date/api/all.json")) {
      return jsonRes(["nodejs", "python", "go"]);
    }
    if (u.startsWith("https://endoflife.date/api/")) {
      return jsonRes(NODE_CYCLES);
    }
    if (u.includes("/orgs/acme/repos")) {
      const page = Number(new URL(u).searchParams.get("page"));
      const slice = repos.slice((page - 1) * 100, page * 100);
      return jsonRes(slice);
    }
    const tree = u.match(/\/repos\/acme\/([^/]+)\/git\/trees\//);
    if (tree) return jsonRes({ truncated: false, tree: files[tree[1]] || [] });
    const runs = u.match(/\/repos\/acme\/([^/]+)\/actions\/runs/);
    if (runs) {
      return jsonRes({
        workflow_runs: [
          {
            conclusion: "success",
            event: "schedule",
            head_branch: "main",
            name: "nightly",
            updated_at: "2026-10-05T00:00:00Z",
          },
          {
            conclusion: "success",
            event: "push",
            head_branch: "main",
            name: "Deploy",
            html_url: "https://github.com/acme/x/actions/runs/1",
            updated_at: "2026-09-28T14:03:11Z",
          },
        ],
      });
    }
    const raw = u.match(/^https:\/\/raw\.githubusercontent\.com\/acme\/([^/]+)\/[^/]+\/(.+)$/);
    if (raw) {
      const content = files[raw[1]]?.find((f) => f.path === raw[2])?.content;
      return content === undefined ? jsonRes({}, { status: 404 }) : textRes(content);
    }
    return jsonRes({}, { status: 404 });
  };
  return { fetchImpl, requests };
}

function jsonRes(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999", ...headers },
  });
}

function textRes(body) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain", "x-ratelimit-remaining": "4999" },
  });
}

function withStubbedFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = original;
  });
}

const blob = (path, content) => ({ path, mode: "100644", type: "blob", sha: path, size: content.length, content });

function makeRepos(count, prefix, extra = () => ({})) {
  const override = typeof extra === "function" ? extra : () => extra;
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}-${i}`,
    full_name: `acme/${prefix}-${i}`,
    default_branch: "main",
    html_url: `https://github.com/acme/${prefix}-${i}`,
    fork: false,
    archived: false,
    ...override(i),
  }));
}

test("F2: every page of repositories is listed, not just the first 1,000", async () => {
  // 1,205 active repos: the old fixed 10-page cap stopped at 1,000 listed and
  // never scanned the last 205.
  const repos = makeRepos(1205, "svc");
  const files = Object.fromEntries(
    repos.map((r) => [r.name, [blob(".nvmrc", "20.19.0\n")]])
  );
  const { fetchImpl, requests } = fakeGitHub({ repos, files });

  const result = await withStubbedFetch(fetchImpl, () => scanOrg("acme", ["nodejs"]));

  assert.equal(result.listedRepos, 1205);
  assert.equal(result.scannedRepos, 1205);
  assert.equal(result.listingTruncated, false);
  assert.equal(result.rows.length, 1205);
  assert.ok(
    requests.some((u) => u.includes("page=13")),
    "the scan should request a 13th page of repositories"
  );
  assert.ok(result.rows.some((r) => r.repo === "acme/svc-1204"), "the last repo must be scanned");
});

test("F2: forks and archived repos are excluded, and limit counts scanned repos", async () => {
  const repos = [
    ...makeRepos(30, "forked", () => ({ fork: true })),
    ...makeRepos(30, "archived", () => ({ archived: true })),
    ...makeRepos(100, "active"),
  ];
  const files = Object.fromEntries(
    repos.map((r) => [r.name, [blob(".nvmrc", "20.19.0\n")]])
  );
  const { fetchImpl } = fakeGitHub({ repos, files });

  const unlimited = await withStubbedFetch(fetchImpl, () => scanOrg("acme", ["nodejs"]));
  assert.equal(unlimited.listedRepos, 160);
  assert.equal(unlimited.forkRepos, 30);
  assert.equal(unlimited.archivedRepos, 30);
  assert.equal(unlimited.scannedRepos, 100);
  assert.equal(unlimited.rows.length, 100);
  assert.ok(!unlimited.rows.some((r) => r.repo.includes("forked")));

  // `limit` is applied after forks/archived are removed, so limit: 20 scans 20
  // repositories rather than "up to 40 listed".
  const limited = await withStubbedFetch(fetchImpl, () => scanOrg("acme", ["nodejs"], { limit: 20 }));
  assert.equal(limited.scannedRepos, 20);
  assert.equal(limited.reposRequested, 20);
  assert.equal(limited.rows.length, 20);
});

test("F1: a whole-org scan of setup-dotnet workflows produces no rows", async () => {
  const repos = makeRepos(40, "dotnet-only");
  const files = Object.fromEntries(
    repos.map((r) => [r.name, [blob(".github/workflows/codeql.yml", WORKFLOW_WITH_DOTNET)]])
  );
  const { fetchImpl } = fakeGitHub({ repos, files });

  const result = await withStubbedFetch(fetchImpl, () => scanOrg("acme", ["nodejs"]));
  assert.equal(result.scannedRepos, 40);
  assert.equal(result.rows.length, 0, "no .NET version may be reported as Node");
});

test("F1: the default four-product list reports each version once, for one product", async () => {
  const repos = makeRepos(10, "svc");
  const files = Object.fromEntries(
    repos.map((r, i) => [
      r.name,
      [
        blob(
          ".github/workflows/ci.yml",
          i === 0
            ? "      - uses: actions/setup-node@v4\n        with:\n          node-version: 20.19.0\n"
            : WORKFLOW_WITH_DOTNET
        ),
      ],
    ])
  );
  const { fetchImpl } = fakeGitHub({ repos, files });
  const products = ["nodejs", "python", "postgresql", "express"];

  const result = await withStubbedFetch(fetchImpl, () => scanOrg("acme", products));

  // Before the fix, the .NET setup input was emitted once per requested product.
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].repo, "acme/svc-0");
  assert.equal(result.rows[0].name, "nodejs");
  assert.equal(result.rows[0].detection, "pinned");
  assert.equal(result.summary.reposWithMatches, 1);
  assert.equal(result.summary.rows, 1);
});

test("F3: the deploy run ignores scheduled jobs and names the reason when blank", async () => {
  const repos = makeRepos(2, "svc");
  const files = Object.fromEntries(repos.map((r) => [r.name, [blob(".nvmrc", "20.19.0\n")]]));
  const { fetchImpl } = fakeGitHub({ repos, files });

  const result = await withStubbedFetch(fetchImpl, () => scanOrg("acme", ["nodejs"]));
  assert.equal(result.rows[0].lastDeployment.name, "Deploy");
  assert.equal(result.rows[0].lastDeployment.branch, "main");
  assert.equal(result.rows[0].lastDeployment.reason, null);

  // Repo whose only successful runs are pull-request checks on a side branch.
  // Distinct repo names: the Actions lookup is cached per repo.
  const prRepos = makeRepos(2, "checks");
  const prFiles = Object.fromEntries(prRepos.map((r) => [r.name, [blob(".nvmrc", "20.19.0\n")]]));
  const prBase = fakeGitHub({ repos: prRepos, files: prFiles });
  const prOnly = async (url) => {
    const u = String(url);
    if (u.includes("/actions/runs")) {
      return jsonRes({
        workflow_runs: [
          {
            conclusion: "success",
            event: "pull_request",
            head_branch: "feature/x",
            name: "PR checks",
            updated_at: "2026-05-18T00:00:00Z",
          },
        ],
      });
    }
    return prBase.fetchImpl(url);
  };
  const prResult = await withStubbedFetch(prOnly, () => scanOrg("acme", ["nodejs"]));
  assert.equal(prResult.rows[0].lastDeployment.date, null);
  assert.equal(prResult.rows[0].lastDeployment.reason, "No successful run on main");
});

test("F7: read failures and truncated trees are reported, not dropped silently", async () => {
  const repos = makeRepos(3, "svc");
  const files = {
    "svc-0": [blob(".nvmrc", "20.19.0\n")],
    "svc-1": [blob(".nvmrc", "20.19.0\n"), blob("package.json", "{}")],
    "svc-2": [blob(".nvmrc", "20.19.0\n")],
  };
  const base = fakeGitHub({ repos, files });
  const fetchImpl = async (url) => {
    const u = String(url);
    // svc-2's tree comes back truncated.
    if (u.includes("/repos/acme/svc-2/git/trees/")) {
      return jsonRes({ truncated: true, tree: files["svc-2"] });
    }
    // svc-1's package.json 404s.
    if (u.includes("svc-1/main/package.json")) return jsonRes({}, { status: 404 });
    return base.fetchImpl(url);
  };

  const result = await withStubbedFetch(fetchImpl, () => scanOrg("acme", ["nodejs"]));
  assert.equal(result.truncatedTrees, 1);
  assert.equal(result.failedFetches, 1);
  assert.ok(result.errors.some((e) => /truncated file tree/.test(e.message)));
  assert.ok(result.errors.some((e) => /Could not read package\.json: HTTP 404/.test(e.message)));
  assert.equal(result.summary.coverage.truncatedTrees, 1);
});

test("F7: per-repo caps record the files they skipped", () => {
  const files = [
    { path: ".github/workflows/a.yml" },
    { path: ".github/workflows/b.yml" },
    { path: ".github/workflows/c.yml" },
    { path: "Dockerfile" },
    { path: "Dockerfile.dev" },
    { path: "package.json" },
    { path: "requirements.txt" },
  ];
  // With no caps configured, nothing is skipped.
  assert.deepEqual(selectCandidates(files).skipped, []);
  assert.equal(selectCandidates(files).candidates.length, 7);
});

test("F11: the summary reports repositories, rows and coverage separately", async () => {
  const repos = makeRepos(6, "svc");
  const files = {
    "svc-0": [blob(".nvmrc", "18.20.5\n")],
    "svc-1": [blob("package.json", JSON.stringify({ engines: { node: ">=8.0.0" } }))],
    "svc-2": [blob("package.json", JSON.stringify({ engines: { node: ">=8.0.0" } }))],
  };
  const { fetchImpl } = fakeGitHub({ repos, files });

  const result = await withStubbedFetch(fetchImpl, () => scanOrg("acme", ["nodejs"]));
  assert.equal(result.summary.scannedRepos, 6);
  assert.equal(result.summary.rows, 3);
  assert.equal(result.summary.reposWithMatches, 3);
  assert.equal(result.summary.pinnedRows, 1);
  assert.equal(result.summary.constraintRows, 2);
  assert.equal(result.summary.reposByStatus.eol, 1);
  assert.equal(result.summary.reposByStatus.constraintsOnly, 2);
});

test("F4: evidence, line and confidence reach every row", async () => {
  const repos = makeRepos(1, "svc");
  const files = {
    "svc-0": [
      blob("plugins/custom-eslint/package.json", '{\n  "engines": {\n    "node": ">=8.0.0"\n  }\n}\n'),
    ],
  };
  const { fetchImpl } = fakeGitHub({ repos, files });

  const result = await withStubbedFetch(fetchImpl, () => scanOrg("acme", ["nodejs"]));
  const row = result.rows[0];
  assert.equal(row.line, 3);
  assert.equal(row.versionSpec, ">=8.0.0");
  assert.match(row.versionRaw, /"node": ">=8\.0\.0"/);
  assert.equal(row.detection, "constraint");
  assert.equal(row.confidence, "Medium");
  // Node 8 is no longer a listed cycle, and the ">=8.0.0" lower bound resolves to
  // no cycle rather than to a cycle built from stripped digits.
  assert.equal(row.eol.cycle, null);
  assert.equal(row.eol.status, "unknown");
});

test("F10: rows carry region and domain source, unmapped is explicit", async () => {
  const repos = makeRepos(2, "svc");
  const files = Object.fromEntries(repos.map((r) => [r.name, [blob(".nvmrc", "22.16.0\n")]]));
  const { fetchImpl } = fakeGitHub({ repos, files });

  const result = await withStubbedFetch(fetchImpl, () => scanOrg("acme", ["nodejs"]));
  assert.equal(result.rows[0].domain, "Unmapped");
  assert.equal(result.rows[0].domainSource, null);
  assert.equal(result.summary.reposByDomain[0].domain, "Unmapped");
  assert.equal(result.summary.reposByDomain[0].repos, 2);
});