/**
 * Synthetic vault with fictional names (section 12 of the plan). Covers the
 * golden query cases: ticket PROJ-123, the tenant isolation decision, a term
 * with a hyphen and a digit (bge-m3), recency, and distinct layers.
 */

export const SYNTHETIC_VAULT: Record<string, string> = {
  '_registry.md': `# Registry

Controlled vocabulary for this vault.

- [[Aurora]] is the main product.
- Embedding model: \`bge-m3\` (evaluated, kept behind a flag).
- Team name: **North Platform**.
`,

  'USER.md': `# USER

## Preferences

- Prefers strict TypeScript in all projects.
- Short answers, one thing at a time.
`,

  'Meetings/2026-07-10 - Weekly Aurora.md': `---
date: 2026-07-10
attendees: [Alice, Bob, Carol]
project: aurora
---
# Weekly Aurora

## Decisions

Bob: On PROJ-123, we agreed that tenant isolation will use a separate schema in Postgres, not row-level security.
Alice: Agreed. PROJ-123 stays scoped to schema per tenant for this phase.
Carol: I will update ticket PROJ-123 with this decision.

## Open items

Bob: The migration of the old data moves to the next sprint.
`,

  'Meetings/2025-01-10 - Old kickoff.md': `---
date: 2025-01-10
project: aurora
---
# Old kickoff

Alice: First conversation about multi-tenancy, nothing decided about isolation yet.
`,

  'Topics/Tenant Isolation.md': `---
project: aurora
---
# Tenant Isolation

## Current state

- Decision from 2026-07-10: tenant isolation by a separate schema in Postgres (see PROJ-123).
- Row-level security was dropped because of audit cost.

## History

<!-- auto -->
- We evaluated bge-m3 for semantic search over tenant documents, deferred for later.
`,

  'Work Log/2026-07.md': `# Work Log 2026-07

## 2026-07-10

- PROJ-123: decision closed in the weekly, isolation by schema. Commit abc123f on branch feat/PROJ-123.

## 2026-07-15

- Review of Carol's PR about schema migration.
`,

  'People/Bob.md': `# Bob

- Tech lead of North Platform.
- Owner of the tenant isolation decision.
`,

  'daily/2026-07-15.md': `# 2026-07-15

- fact: we closed the review of the schema migration with Carol.
`,
};
