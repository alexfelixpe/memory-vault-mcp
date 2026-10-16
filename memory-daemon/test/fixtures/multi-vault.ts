/**
 * Three vaults for the read-isolation tests: two client vaults with mirrored
 * content plus the shared personal vault. Every file matches the same query
 * ("quarterly billing migration"), so a search that is NOT scoped returns all
 * three — which is exactly what these tests must catch.
 *
 * Markers are unique strings, so an assertion can name the one file that must
 * never appear. clientB is deliberately the "loudest" vault: its note carries a
 * far-future date (so it would win any recency listing) and its own ticket key,
 * substring-only word and registry vocabulary.
 */

export const GLOBAL_VAULT_FILES: Record<string, string> = {
  'USER.md': `# USER

## Preferences <!-- auto -->

- GLOBAL_USER_MARKER prefers short answers everywhere.
`,
  'MEMORY.md': `# MEMORY

## Decisions <!-- auto -->

- GLOBAL_MARKER the quarterly billing migration convention applies to every client project.
`,
  'daily/2026-07-20.md': `# 2026-07-20

- fact: GLOBAL_DAILY_MARKER reviewed the quarterly billing migration checklist today.
`,
};

/**
 * The curated seed every vault carries now that vaults are self-contained: its
 * own USER.md and MEMORY.md, not only PROJECT.md. The text deliberately does NOT
 * match SHARED_QUERY, so these files add no hits and cannot change any ranking
 * assertion; they exist so a write to file:'user' or file:'memory' has a target.
 */
const curatedSeed = (marker: string): Record<string, string> => ({
  'USER.md': `# USER\n\n## Preferences <!-- auto -->\n\n- ${marker}_USER_MARKER prefers short answers.\n`,
  'MEMORY.md': `# MEMORY\n\n## Decisions <!-- auto -->\n\n- ${marker}_MEMORY_MARKER commit messages stay in English.\n`,
});

export const CLIENT_A_FILES: Record<string, string> = {
  ...curatedSeed('ALPHA'),
  '_registry.md': `# Registry

- [[Alphacorp Ledger]] is the ledger system of this client.
`,
  'PROJECT.md': `# PROJECT

## Decisions <!-- auto -->

- ALPHA_PROJECT_MARKER the quarterly billing migration decision for this client.
`,
  'Notes/alpha-decisions.md': `---
date: 2026-07-01
---
# Alpha decisions

- ALPHA_MARKER the quarterly billing migration was signed off in AAA-111.
- The alphaxylophone report runs after the quarterly billing migration.
`,
  'Notes/alpha-plan.md': `# Alpha plan

- ALPHA_PLAN_MARKER the quarterly billing migration plan for the next quarter.
`,
};

export const CLIENT_B_FILES: Record<string, string> = {
  ...curatedSeed('BETA'),
  '_registry.md': `# Registry

- [[Betacorp Ledger]] is the ledger system of this client.
`,
  'PROJECT.md': `# PROJECT

## Decisions <!-- auto -->

- BETA_PROJECT_MARKER the quarterly billing migration decision for this client.
`,
  'Notes/beta-decisions.md': `---
date: 2030-01-01
---
# Beta decisions

- BETA_MARKER the quarterly billing migration was signed off in BBB-222.
- The betaxylophone report runs after the quarterly billing migration.
`,
  'Notes/beta-plan.md': `# Beta plan

- BETA_PLAN_MARKER the quarterly billing migration plan for the next quarter.
`,
};

/** The query every vault answers, so only the scoping can explain the result. */
export const SHARED_QUERY = 'quarterly billing migration';
