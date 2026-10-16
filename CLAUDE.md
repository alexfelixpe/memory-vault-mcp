# memory-vault — CLAUDE.md

Personal long-term memory system for its owner. Local, portable, agent-agnostic.
Markdown vaults are the source of truth; a single daemon (`memoryd`) is the only
writer; a thin MCP proxy (`memory-mcp`) and a CLI (`memory`) talk to it over a
Windows named pipe. Hybrid search: SQLite FTS5 (BM25) + local embeddings.

Primary platform: Windows 11. Stack: Node 22+, TypeScript, better-sqlite3.

## Read this first

The two build documents live in `docs/` and are the single source of truth:

1. `docs/implementation-plan.md` — WHAT to build and HOW: closed
   decisions, MCP tool contracts, SQLite DDL, the write pipeline, search
   constants, the 6 delivery increments, blocking tests, risks. Start here.
2. `docs/portable-memory-architecture-v2.md` — the architecture behind it (reference).

Do not re-litigate the decisions in sections 2 and 3 of the implementation plan.
They were closed with the owner on 2026-07-21. If something proves impossible,
surface it; don't silently choose differently.

## Current status

- **Increments 1-3 done (2026-07-21)**. Inc 1: lexical search (FTS5, RRF,
  identifier bypass, CLI, MCP `memory_search`). Inc 2: `memoryd`
  single-instance daemon (exclusive pipe = mutex; cross-process bind error on
  Windows is EACCES), NDJSON protocol, watcher + 300 s reconcile, proxy with
  spawn-on-demand + read-only fallback. Inc 3: hybrid search — embedding
  worker (separate process, stdio JSONL, e5-small ONNX q8), brute-force
  vector index, embed backlog in the supervisor, cold-start degradation
  (`degraded: lexical_only`), `<untrusted-memory>` envelope with nonce +
  breakout neutralization, injection scan at index time (`inj_flags`,
  `scanner_version` re-index). 127 tests (1 ONNX smoke gated behind
  MEMORY_TEST_ONNX=1). Verified live: 2349 chunks embedded in ~3.5 min,
  vector channel in results, envelope on meeting snippets, scan-corpus
  baseline 0 of 92 files fired.
- Install quirk (Windows, this machine): `npm install --ignore-scripts`, plus a
  portable Node 22 put first on `PATH`. See `memory-daemon/README.md`.
- Test gotcha: integration tests must run in the vitest `forks` pool —
  chokidar's fs.watch is unreliable inside worker_threads on Windows.
- **Increment 4 done (2026-07-21)**: the six MCP tools, single write
  pipeline (serial queue, 3-level hash precondition, secret scan + denylist
  + injection gate, simulation, budget with forced consolidation on attempt
  3, atomic write + .bak, immediate re-index), frozen per-session snapshot,
  `memory snapshot --out`, SessionStart hook (net+JSON only — hook-bundle
  test enforces it). T1 and T2 pass; 151 tests. Verified live: write lands
  and is searchable instantly; same-section concurrent edit is refused with
  STALE_HASH (other-section edits merge, by design of the 3-level hash).
- **Increment 5 done (2026-07-21)**: capture. Turn counter (Stop hook only),
  tolerant JSONL reader with watermark + uuid dedup (never regresses on
  crash), triage via OpenRouter (openai/gpt-oss-120b, forced tool call, zod,
  deterministic post-validation kills volatile IDs), pending queue
  (queue.jsonl truth + SQLite projection + INBOX.md — REMOVED 2026-07-28,
  see below), `memory pending accept|reject` writing through the single
  pipeline (also removed),
  retrieval push frozen with the snapshot, redacted sessions/ (blocking
  requirement verified). 156 tests. Live pass verified with the real key.
- **Increment 6 done (2026-07-21), reshaped by the owner's decision**: instead of
  Wilson-based graduation, capture AUTO-PROMOTES immediately when class is
  safe (style_preference, flow_convention, env_gotcha) AND origin
  is session_extract AND confidence >= 0.8 — through the same write
  pipeline, logged as accepted/auto. third_party NEVER auto-promotes (code
  lock unchanged). Backup job, called curation until 2026-09-09 (daily, stamp-based): 7-day TTL on pending,
  single weekly digest in vault/digests/, queue alarm at 40 open, local git
  auto-commit of the vault (no push). `memory backup` runs it manually.
  158 tests. ALL 6 INCREMENTS DELIVERED.
- **Review queue REMOVED (2026-07-28, owner's decision).** Capture stays ON and
  unchanged: turn counter, tolerant JSONL reader, triage, redacted session
  transcript, retrieval push. Auto-promotion is unchanged, including the lock
  that third_party never auto-promotes. What went away is everything a human had
  to review: `capture/queue.ts`, the SQLite `pending` table (dropped by
  migration 002; schema_version is now 2), `vault/pending/` (queue.jsonl +
  INBOX.md), the `pending.list` / `pending.decide` daemon methods, the whole
  `memory pending` command, the open-queue count in `memory status` and
  `memory show`, and the queue-driven parts of the backup job (then called curation) (7-day TTL, weekly
  digest in `vault/digests/`, alarm at 40 open). The backup job now only does the
  local git auto-commit of the vault, with its secret guard. **A captured item
  now has exactly two outcomes: written straight to memory, or discarded.** A
  discarded item is logged at debug level only; it reaches no file, no SQLite
  row and no search index. `MutateParams.humanApproved` is gone with the queue,
  so THIRD_PARTY_BLOCKED is now unconditional in the write pipeline. The
  auto-promotion record lives in the durable write log
  (`vault/.memory/write-log.jsonl`, actor `auto_promote`), which the pipeline
  already wrote. 411 tests.
- **Post-delivery hardening (2026-07-28/29)**: the registry vocabulary loads
  from `Topics/_registry.md` too and reads table first columns; a registry
  change force-reindexes the vault (`force` option on reconcile/indexFile).
  Capture triage survives over-long responses (10-item truncation, prompt cap).
  The triage backend is configurable: `triage: backend: claude-cli` runs Haiku
  headless on the owner's own Claude account (active here), OpenRouter is the
  fallback; a logged-out CLI raises a throttled notice through the Stop hook
  (asyncRewake) and `memory status`, and captured turns wait, nothing lost.
- **Tier phase 1 (2026-07-29, outcome of the processing-layer debate)**: every
  chunk carries a density `tier` (curated | processed | raw) from its section
  (migration 003, backfilled by SCANNER_VERSION 4); search hits expose it.
  Ranking applied 2026-09-08: a `raw` chunk's fused score is multiplied by
  `TIER_RAW_FACTOR` (0.7); the tier still never touches the fence,
  promotion, or origin. The per-file cap half was dropped on 2026-09-10
  (owner's decision); see `docs/tier-baseline.md`, section "Applied (2026-09-08)".
  Kill condition and measured baseline live in `docs/tier-baseline.md`; both
  gates met, the ranking change landed on 2026-09-08.
  Side fix: the reconcile mtime shortcut now honours `scanner_version`, so a
  version bump really re-indexes untouched files. 484 tests.
- **The vault left the code repo's git (2026-07-29, owner's decision)**: the
  history was rewritten and force-pushed without `vault/`, the folder is
  gitignored, and the vault is its own local-only git repository that is never
  pushed; the daily backup commits inside it. A local branch
  `backup/pre-vault-purge` keeps the old history and must never be pushed.
- **External read-only roots (2026-08-01, for a third-party tool's data folder)**: config
  `external_roots: <name>: {path, vault}` indexes a foreign tool's folder into
  a vault's READ scope without the folder living in the vault. Each root is one
  more indexer context under the synthetic identity `<vault>::<name>` (the `::`
  is outside the vault-name charset, so no collision with real vaults), which
  the whole reconcile/watcher machinery treats as just another root.
  `readableVaults` appends the roots owned by a readable vault, so every search
  path inherits the rule. Files there are HARDENED at index time: origin pinned
  to `third_party_derived` (fenced untrusted, injection-scanned), the curated
  layer unreachable, never evergreen, whatever the frontmatter claims; a
  `_registry.md` in an external root does not swap vocabulary (the owner
  vault's registry rules). Writes can never land there: the write pipeline
  resolves roots via `config.vaults`, which never holds a synthetic id.
  479 tests.
- `vault/` holds the global personal vault (USER.md, MEMORY.md, daily/ born
  2026-07-21). It still holds `pending/` and `digests/` from before the queue
  was removed. Nothing reads or writes them; leave them alone unless the owner
  says otherwise.
- **Vault isolation reshaped (2026-07-28, owner's decision)**: memory is separate
  per project by DEFAULT. `readableVaults` returns the caller's vault ALONE;
  `global` joins only when the repo's `.memory.yml` says `share_global: true`
  (an optional boolean on `MarkerSchema`, reads only). A broken marker now reads
  NOTHING and refuses EVERY write with `VAULT_UNRESOLVED`, because the shared
  vault needs an invitation a broken marker cannot give. Every vault is
  self-contained: `file:'user'` and `file:'memory'` resolve to the CALLER's
  vault, and `memory vault add` seeds USER.md, MEMORY.md and PROJECT.md. A repo
  with no marker is unchanged (config default vault), so a single-vault setup
  sees no difference. 433 tests.

## Key facts an agent needs

| Fact | Value |
|------|-------|
| Global vault | `vault/` in this folder, but OUT of this repo's git since 2026-07-29: it has its own local-only git history and is never pushed. It is the SHARED PERSONAL vault, not a vault everyone reads: a marked repo sees it only with `share_global: true`. |
| Other vaults | Any extra vault (for example an Obsidian work vault) lives outside this repo, at a path set in config. Never move it, never commit it here, never write its path into a tracked file. Every vault is self-contained: its own USER.md, MEMORY.md, PROJECT.md, daily/ and sessions/. |
| Repo marker | `.memory.yml` at a repo root: `vault: <name>`, plus optional `share_global: true` to also READ the shared vault. Writes always land in the caller's own vault. |
| SQLite index | `%LOCALAPPDATA%\memory\` — never inside a vault, always rebuildable |
| Config + API keys | `config.local.yml` in this repo's root — kept out of Git via `.git/info/exclude`; legacy fallback `%APPDATA%\memory\config.yml` |
| Triage LLM | Claude Haiku via the local Claude CLI (`triage: backend: claude-cli` in config, 2026-07-28); OpenRouter stays as the fallback backend |
| Embeddings | `Xenova/multilingual-e5-small` default; bge-m3 behind a flag |
| Commits | Conventional commits, English, no AI attribution lines |

## Hard rules

- The daemon is the only process that writes to vaults or the index.
- Every write goes through the pipeline order in section 7 of the plan
  (serial queue → re-read → hash precondition → secret scan → simulate →
  budget → atomic tmp+fsync+rename).
- Secret scan blocks in ALL layers. Session transcripts enter `vault/sessions/`
  only redacted (`[REDACTED:rule]`).
- Content derived from third parties (meeting transcripts, tool results) never
  auto-promotes to the curated layer. Human approval is permanent for it.
- Reads are scoped to the caller's own vault. The shared `global` vault is added
  only by the repo marker's `share_global: true`, never by a tool argument, and
  never as a fallback. A write always lands in the caller's own vault.
- Type-check before every commit: `npm run typecheck` in `memory-daemon/`.
