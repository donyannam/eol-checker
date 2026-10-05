// Print the domain mapping worklist: every GitHub team in the org with an empty
// region/category to fill in, plus every repo that is still Unmapped once the
// override table and team table are applied.
//
//   GITHUB_ORG=masterysystems node scripts/seed-domains.js
//
// Paste the `teams` object into domains.json, then fill in the Compass regions
// and categories, re-run to see what is left Unmapped, and add those repos to
// `repos`.

const {
  listOrgRepos,
  listRepoTeamSlugs,
  functionalDomain,
  domainRules,
  UNMAPPED,
} = require("../server.js");

async function main() {
  const owner = (process.argv[2] || process.env.GITHUB_ORG || "").trim();
  if (!owner) {
    console.error("Usage: node scripts/seed-domains.js <github-org>");
    process.exit(1);
  }

  const { repos } = await listOrgRepos(owner);
  const active = repos.filter((r) => !r.fork && !r.archived);
  const { byRepo, teamNames } = await listRepoTeamSlugs(owner);

  const teams = {};
  for (const slug of teamNames) teams[slug] = { region: "", category: "" };

  const unmapped = [];
  for (const repo of active) {
    const mapped = functionalDomain(repo, byRepo);
    if (mapped.domain === UNMAPPED) unmapped.push(repo.name);
  }

  console.error(
    `${active.length} active repos, ${teamNames.length} teams, ` +
      `${active.length - unmapped.length} mapped, ${unmapped.length} unmapped`
  );
  console.log(JSON.stringify({ teams }, null, 2));

  console.error("\nUnmapped repos (add to domains.json `repos`, or map their team above):");
  for (const name of unmapped.sort()) console.error(`  ${name}`);

  if (Object.keys(domainRules.teams).length === 0 && teamNames.length) {
    console.error("\nNote: domains.json has no `teams` entries yet, so only `repos` overrides applied.");
  }
}

main().catch((err) => {
  console.error(`seed-domains failed: ${err.message}`);
  process.exit(1);
});