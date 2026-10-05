// Regression tests for the 2026-10-05 review findings. Every case here is taken
// from the report: a repo/file/line that was read by hand, or a specific
// behaviour the finding says was wrong.
//
//   npm test

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectInFile,
  classifyFile,
  isConstraintSpec,
  normVersion,
  versionTuple,
  findCycleForVersion,
  pickDeployRun,
  deployRunReason,
  functionalDomain,
  productVariants,
  rollupByRepo,
  domainRules,
  UNMAPPED,
} = require("../server.js");

const NODE = productVariants("nodejs");
const PYTHON = productVariants("python");
const GO = productVariants("golang");

// ---------------------------------------------------------------------------
// F1 - other languages' setup steps reported as Node
// ---------------------------------------------------------------------------

test("F1: setup-dotnet version is not a Node version", () => {
  const yaml = [
    "name: CodeQL",
    "jobs:",
    "  analyze:",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-dotnet@v4",
    "        with:",
    "          dotnet-version: '8.0.x'",
  ].join("\n");
  assert.deepEqual(detectInFile("workflow", yaml, NODE), []);
});

test("F1: setup-go version is not a Node version", () => {
  // mastermind-argo actionlint.yaml: go-version: 1.25 was reported as Node 12.
  const yaml = ["      - uses: actions/setup-go@v5", "        with:", "          go-version: 1.25"].join("\n");
  assert.deepEqual(detectInFile("workflow", yaml, NODE), []);
});

test("F1: setup-ruby and setup-java versions are not Node versions", () => {
  const yaml = [
    "      - uses: ruby/setup-ruby@v1",
    "        with:",
    "          ruby-version: 3.3.5",
    "      - uses: actions/setup-java@v4",
    "        with:",
    '          java-version: "17"',
  ].join("\n");
  assert.deepEqual(detectInFile("workflow", yaml, NODE), []);
});

test("F1: setup-node is still detected when scanning for nodejs", () => {
  const yaml = [
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 20.11.0",
    "          cache: npm",
  ].join("\n");
  const found = detectInFile("workflow", yaml, NODE);
  assert.equal(found.length, 1);
  assert.equal(found[0].version, "20.11.0");
  assert.equal(found[0].constraint, false);
  assert.equal(found[0].line, 3);
  assert.match(found[0].raw, /node-version: 20\.11\.0/);
});

test("F1: an unrelated setup-* step clears the pending input", () => {
  // Neither step arms the Node matcher, so neither input is collected.
  const yaml = [
    "      - uses: actions/setup-dotnet@v4",
    "        with:",
    "          dotnet-version: '10.0'",
    "      - uses: actions/setup-python@v5",
    "        with:",
    "          python-version: '3.11'",
  ].join("\n");
  assert.deepEqual(detectInFile("workflow", yaml, NODE), []);
});

test("F1: a node-version line with no setup-node step is not collected", () => {
  const yaml = [
    "      - uses: actions/setup-python@v5",
    "        with:",
    "          python-version: '3.11'",
    "          cache: pip",
    "          node-version: 18",
  ].join("\n");
  assert.deepEqual(detectInFile("workflow", yaml, NODE), []);
});

test("F1: the reverse leak - node-version is not a Python version", () => {
  const yaml = [
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 24",
  ].join("\n");
  assert.deepEqual(detectInFile("workflow", yaml, PYTHON), []);
});

test("F1: setup-python still matches a python scan, setup-go a golang scan", () => {
  const py = ["      - uses: actions/setup-python@v5", "        with:", "          python-version: '3.11.9'"].join("\n");
  assert.equal(detectInFile("workflow", py, PYTHON)[0].version, "3.11.9");

  const go = ["      - uses: actions/setup-go@v5", "        with:", "          go-version: '1.25.0'"].join("\n");
  assert.equal(detectInFile("workflow", go, GO)[0].version, "1.25.0");
});

test("F1: an unknown setup action never matches any input", () => {
  const yaml = ["      - uses: peaceiris/actions-gh-pages@v4", "        with:", "          node-version: 20"].join("\n");
  assert.deepEqual(detectInFile("workflow", yaml, NODE), []);
});

test("F1: container images in workflows are still detected", () => {
  const yaml = ["    container:", "      image: node:18.16.0"].join("\n");
  assert.equal(detectInFile("workflow", yaml, NODE)[0].version, "18.16.0");
});

// ---------------------------------------------------------------------------
// F4 - ranges reported as the version in use
// ---------------------------------------------------------------------------

test("F4: engines lower bound is a constraint, not a version", () => {
  // mastery-frontend plugins/custom-eslint/package.json: "node": ">=8.0.0"
  const pkg = JSON.stringify({ engines: { node: ">=8.0.0" } }, null, 2);
  const found = detectInFile("package-json", pkg, NODE);
  assert.equal(found.length, 1);
  assert.equal(found[0].spec, ">=8.0.0");
  assert.equal(found[0].version, "8.0.0");
  assert.equal(found[0].constraint, true);
  assert.match(found[0].raw, /"node": ">=8\.0\.0"/);
});

test("F4: union range is a constraint and keeps its raw spec", () => {
  const pkg = JSON.stringify({ engines: { node: "^16 || ^18 || ^20 || >=22" } }, null, 2);
  const found = detectInFile("package-json", pkg, NODE);
  assert.equal(found[0].constraint, true);
  assert.equal(found[0].spec, "^16 || ^18 || ^20 || >=22");
});

test("F4: pinned versions stay pinned", () => {
  assert.equal(isConstraintSpec("18.17.0"), false);
  assert.equal(isConstraintSpec("v24"), false);
  assert.equal(isConstraintSpec("3.10"), false);
  assert.equal(isConstraintSpec("20.11.1-alpine"), false);
  assert.equal(isConstraintSpec("8.0.x"), true);
  assert.equal(isConstraintSpec("~2.3.4"), true);
  assert.equal(isConstraintSpec("latest"), false);
  assert.equal(isConstraintSpec(">=1.0.0 <2.0.0"), true);
  assert.equal(isConstraintSpec("1.2.3 - 2.0.0"), true);
  assert.equal(isConstraintSpec("18 || 20"), true);
});

test("F4: peerDependencies and devDependencies are all reported with their source line", () => {
  const pkg = [
    "{",
    '  "devDependencies": {',
    '    "typescript": "5.4.5"',
    "  },",
    '  "peerDependencies": {',
    '    "node": ">=18"',
    "  },",
    '  "dependencies": {',
    '    "node-fetch": "2.7.0"',
    "  }",
    "}",
  ].join("\n");
  const found = detectInFile("package-json", pkg, NODE);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 6);
  assert.equal(found[0].constraint, true);
  assert.match(found[0].raw, /"node": ">=18"/);
});

test("F4: every detection carries an evidence line", () => {
  const files = [
    ["pin-node", "20.11.0\n", NODE],
    ["docker", "FROM node:20.11.0-alpine\n", NODE],
    ["tool-versions", "nodejs 18.17.0\n", NODE],
    ["go-mod", "go 1.25.0\n", GO],
    ["requirements", "python>=3.11\n", PYTHON],
  ];
  for (const [type, content, variants] of files) {
    const found = detectInFile(type, content, variants);
    assert.equal(found.length, 1, `${type} should detect one version`);
    assert.equal(typeof found[0].line, "number", `${type} should carry a line number`);
    assert.ok(found[0].raw.length > 0, `${type} should carry evidence`);
  }
});

test("F4: pin files report the line holding the value", () => {
  const found = detectInFile("pin-node", "# runtime\n20.11.0\n", NODE);
  assert.equal(found[0].version, "20.11.0");
  assert.equal(found[0].line, 2);
});

// ---------------------------------------------------------------------------
// F6 - release cycle matching
// ---------------------------------------------------------------------------

const NODE_CYCLES = [
  { cycle: "12", eol: "2022-04-30" },
  { cycle: "14", eol: "2023-04-30" },
  { cycle: "16", eol: "2023-09-11" },
  { cycle: "18", eol: "2025-04-30" },
  { cycle: "20", eol: "2026-04-30" },
  { cycle: "22", eol: "2027-04-30" },
  { cycle: "24", eol: "2028-04-30" },
];
const GO_CYCLES = [{ cycle: "1.21" }, { cycle: "1.24" }, { cycle: "1.25" }];
const PYTHON_CYCLES = [
  { cycle: "3.8" },
  { cycle: "3.9" },
  { cycle: "3.10" },
  { cycle: "3.11" },
  { cycle: "3.12" },
  { cycle: "3.13" },
  { cycle: "3.14" },
];

test("F6: Go 1.25 does not land on Node cycle 12", () => {
  assert.equal(findCycleForVersion(NODE_CYCLES, "1.25"), null);
  assert.equal(findCycleForVersion(GO_CYCLES, "1.25").cycle, "1.25");
});

test("F6: 3.10 does not land on cycle 3 and 3.1.4 does not exact-match 3.14", () => {
  assert.equal(findCycleForVersion(NODE_CYCLES, "3.10"), null);
  assert.equal(findCycleForVersion(PYTHON_CYCLES, "3.10").cycle, "3.10");
  // Stripping digits would have matched the first entry, cycle 3.14.
  assert.equal(findCycleForVersion(PYTHON_CYCLES, "3.1.4"), null);
});

test("F6: the longest cycle that prefixes the version wins", () => {
  // "3.1.4" matches cycle 3.1 here, not the longer-looking cycle 3.14, and not
  // the shorter cycle 3.
  const cycles = [{ cycle: "3" }, { cycle: "3.1" }, { cycle: "3.14" }];
  assert.equal(findCycleForVersion(cycles, "3.1.4").cycle, "3.1");
  assert.equal(findCycleForVersion(cycles, "3.14.0").cycle, "3.14");
  assert.equal(findCycleForVersion(cycles, "3.9").cycle, "3");
  assert.equal(findCycleForVersion(NODE_CYCLES, "20.11.1").cycle, "20");
  assert.equal(findCycleForVersion(PYTHON_CYCLES, "3.13.4").cycle, "3.13");
  assert.equal(findCycleForVersion(PYTHON_CYCLES, "3.8.18").cycle, "3.8");
});

test("F6: a version with no cycle resolves to null, not to a stray prefix", () => {
  assert.equal(findCycleForVersion(NODE_CYCLES, "8.17.0"), null);
  assert.equal(findCycleForVersion(NODE_CYCLES, ""), null);
  assert.equal(findCycleForVersion([], "20.1.0"), null);
});

test("F6: versionTuple keeps components separate", () => {
  assert.deepEqual(versionTuple("24.15.0"), [24, 15, 0]);
  assert.deepEqual(versionTuple("1.25"), [1, 25]);
  assert.deepEqual(versionTuple("3.10"), [3, 10]);
  assert.deepEqual(versionTuple("v20"), [20]);
  assert.deepEqual(versionTuple("3.10.0-rc1"), [3, 10, 0]);
});

// ---------------------------------------------------------------------------
// F7 - silent per-repo limits
// ---------------------------------------------------------------------------

test("F7: non-YAML files under .github/workflows are not workflows", () => {
  assert.equal(classifyFile(".github/workflows/Android-Deploy-Dev-Internal-devapp.txt"), null);
  assert.equal(classifyFile(".github/workflows/notes.md"), null);
  assert.equal(classifyFile(".github/workflows/README"), null);
  assert.equal(classifyFile(".github/workflows/build.yml"), "workflow");
  assert.equal(classifyFile(".github/workflows/build.yaml"), "workflow");
  assert.equal(classifyFile(".gitlab-ci.yml"), "workflow");
  assert.equal(classifyFile("azure-pipelines.yaml"), "workflow");
});

test("F7: other manifest types still classify", () => {
  assert.equal(classifyFile("Dockerfile"), "docker");
  assert.equal(classifyFile("src/Dockerfile.dev"), "docker");
  assert.equal(classifyFile(".nvmrc"), "pin-node");
  assert.equal(classifyFile("plugins/custom-eslint/package.json"), "package-json");
  assert.equal(classifyFile("requirements-dev.txt"), "requirements");
  assert.equal(classifyFile(".tool-versions"), "tool-versions");
  assert.equal(classifyFile("docker-compose.override.yml"), "compose");
  assert.equal(classifyFile("README.md"), null);
});

// ---------------------------------------------------------------------------
// F3 - last deployment
// ---------------------------------------------------------------------------

test("F3: a scheduled run is not a deploy run", () => {
  // In `configuration` the newest successful runs are scheduled jobs firing
  // many times a day; the old column reported them as deployments.
  const runs = [
    { conclusion: "success", event: "schedule", head_branch: "main", name: "Nightly", updated_at: "2026-10-05" },
    { conclusion: "success", event: "push", head_branch: "main", name: "Deploy", updated_at: "2026-09-28" },
  ];
  assert.equal(pickDeployRun(runs, "main").run.name, "Deploy");
});

test("F3: a successful run on another branch is not a deploy run", () => {
  const runs = [
    { conclusion: "success", event: "pull_request", head_branch: "feature/x", name: "PR checks", updated_at: "2026-05-18" },
  ];
  const { run } = pickDeployRun(runs, "main");
  assert.equal(run, null);
  assert.equal(deployRunReason(pickDeployRun(runs, "main").stats, "main", 1), "No successful run on main");
});

test("F3: a failed newest run is skipped for an older successful deploy", () => {
  const runs = [
    { conclusion: "failure", event: "push", head_branch: "main", name: "Deploy", updated_at: "2026-10-05" },
    { conclusion: "success", event: "push", head_branch: "main", name: "Deploy", updated_at: "2026-09-28" },
  ];
  assert.equal(pickDeployRun(runs, "main").run.updated_at, "2026-09-28");
});

test("F3: every blank cell has a reason", () => {
  const cases = [
    [[], "main", "No workflow runs"],
    [[{ conclusion: "failure", event: "push", head_branch: "main" }], "main", "No successful run"],
    [
      [{ conclusion: "success", event: "schedule", head_branch: "main" }],
      "main",
      "No deploy-type run on main in the last 1 runs",
    ],
  ];
  for (const [runs, branch, expected] of cases) {
    assert.equal(deployRunReason(pickDeployRun(runs, branch).stats, branch, runs.length), expected);
  }
});

// ---------------------------------------------------------------------------
// F10 - domain mapping
// ---------------------------------------------------------------------------

test("F10: substring rules are gone, so mid-word matches report Unmapped", () => {
  const misfiled = [
    ["mastery-credit", "EDI"], // "edi" inside "credit"
    ["mass-uploads-library", "Load Status"], // "load" inside "upload"
    ["data-upload-service", "Load Status"],
    ["capacity-load-testing", "Load Status"],
    ["api-regression-tests", "Backend API"], // catch-all "api"
    ["external-api-code-standards", "Backend API"],
  ];
  for (const [name] of misfiled) {
    assert.equal(
      functionalDomain({ name, full_name: `masterysystems/${name}` }).domain,
      UNMAPPED,
      `${name} must not be filed by substring`
    );
  }
});

test("F10: an explicit repo override still maps", () => {
  const mapped = functionalDomain({ name: "mastery-frontend", full_name: "masterysystems/mastery-frontend" });
  assert.equal(mapped.domain, "Frontend");
  assert.equal(mapped.domainSource, "repo-override");
});

test("F10: a repo with no rule is explicitly Unmapped, never a hostname", () => {
  const mapped = functionalDomain({
    name: "alchemy-abacus",
    full_name: "masterysystems/alchemy-abacus",
    homepage: "https://abacus.masterysys.atlassian.net/wiki/",
  });
  assert.equal(mapped.domain, UNMAPPED);
  assert.equal(mapped.region, "");
  assert.equal(mapped.domainSource, null);
});

test("F10: a repo override wins over the owning team's category", (t) => {
  domainRules.teams["alchemy-team"] = { region: "Mastery Central", category: "Alchemy" };
  t.after(() => delete domainRules.teams["alchemy-team"]);
  const teamSlugs = new Map([["alchemy-abacus", "alchemy-team"]]);

  const viaTeam = functionalDomain({ name: "alchemy-abacus" }, teamSlugs);
  assert.equal(viaTeam.domain, "Alchemy");
  assert.equal(viaTeam.region, "Mastery Central");
  assert.equal(viaTeam.domainSource, "team:alchemy-team");

  const override = functionalDomain({ name: "mastery-frontend" }, teamSlugs);
  assert.equal(override.domain, "Frontend");
  assert.equal(override.domainSource, "repo-override");
});

// ---------------------------------------------------------------------------
// F11 - rows vs repositories
// ---------------------------------------------------------------------------

const row = (repo, status, detection = "pinned") => ({
  repo,
  repoUrl: `https://github.com/masterysystems/${repo}`,
  domain: "Alchemy",
  region: "",
  detection,
  eol: { status },
});

test("F11: the rollup counts repositories, not rows", () => {
  const rows = [
    row("alchemy-tendering", "eol"),
    row("alchemy-tendering", "eol"),
    row("alchemy-tendering", "active"),
    row("data-upload-service", "active"),
    row("external-api-utils", "active"),
    row("mastery-frontend", "eol", "constraint"),
  ];
  const repos = rollupByRepo(rows);
  assert.equal(repos.length, 4);

  const byRepo = Object.fromEntries(repos.map((r) => [r.repo, r]));
  assert.equal(byRepo["alchemy-tendering"].rows, 3);
  assert.equal(byRepo["alchemy-tendering"].worst, "eol");
  assert.equal(byRepo["alchemy-tendering"].eolRows, 2);
  assert.equal(byRepo["data-upload-service"].worst, "active");

  // A repo whose only evidence is a range is not counted as EOL.
  assert.equal(byRepo["mastery-frontend"].constraintsOnly, true);
  assert.equal(byRepo["mastery-frontend"].eolRows, 0);
});

test("F11: 379 rows across 119 repos roll up to 119 repositories", () => {
  const rows = [];
  for (let i = 0; i < 119; i++) {
    const perRepo = i < 22 ? 4 : 3; // 22*4 + 97*3 = 379 rows
    for (let j = 0; j < perRepo; j++) rows.push(row(`repo-${i}`, "active"));
  }
  assert.equal(rows.length, 379);
  assert.equal(rollupByRepo(rows).length, 119);
});

test("normVersion still extracts the first numeric version", () => {
  assert.equal(normVersion("^18.0.0"), "18.0.0");
  assert.equal(normVersion("v24"), "24");
  assert.equal(normVersion("lts/*"), null);
});