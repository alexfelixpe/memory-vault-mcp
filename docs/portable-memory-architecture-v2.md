# Architecture plan v2 — Personal long-term memory, local and portable

**2026-07-21 — revision after an expert panel** (5 adversarial judges reviewed v1 against the Hermes benchmark; this document folds in the 8 high-priority fixes and the medium-priority ones). Replaces the first version of this plan.

The panel's scores for v1: retrieval 7.5 · write/curation 5.5 · robustness 5.5 · context/cache 6.0 · scale 7.5 (Hermes = 7). Conclusion: a stronger foundation than Hermes, but the operating loop was only half copied. v2 closes the gaps.

---

## 1. Fixed decisions (context built up over the conversation)

- **Local-only.** All capture and writing happens on the owner's machine. Cloud chat apps are outside the capture scope.
- **Source of truth = Markdown vault(s)** (Obsidian). The existing work vault (`Meetings/`, `Topics/` with `<!-- auto -->`, `People/`, `Work Log/`, `_registry.md`) already implements the layered pattern by hand and is kept as is.
- **Capture host = Claude Code** (VS Code), through hooks + an MCP server.
- **Multi-project → multi-vault**, routed by project; see §3.
- **Cloud notebook tool = retired** (decision 2026-07-21). The MCP with hybrid search takes over the Q&A role (local RAG). The meeting import loses its upload step and becomes only a copy of the notes into Obsidian.
- **`CLAUDE.md` stays in the repo** (project memory, versioned with the code); the vault is the personal memory across projects.
- **Meetings are curated by distillation**: the raw transcript stays whole in `Meetings/` (the reservoir); a distillation step moves decisions into `Topics/` with a controlled vocabulary and promotion only with approval; this flow is kept and now also feeds the search index.

---

## 2. Layers and numbers (panel fix: a ceiling with no number is theater)

| Layer | Content | Budget | Behavior at the ceiling |
|---|---|---|---|
| **Curated / always-injected** | `USER.md` (global) | **~1,400 chars** | Rejection + forced consolidation in the same turn (atomic batch against the FINAL budget; the error returns `current_entries`; max 3 attempts/turn) |
| | `MEMORY.md` (global) | **~2,200 chars** | same |
| | `projetos/<current>.md` | **~1,500 chars** | same, with **demotion** of the still-valid excess to the reservoir |
| **Searchable reservoir** | old projects, `*-archive.md`, `daily/`, `Meetings/` | no ceiling | Never injected; retrieved via `memory_search`; under **periodic curation + time decay** (§7) |
| **Raw history** | `sessions/`, git | immutable | Tiered retention: ~90 days hot/indexed → then compressed and out of the index (they stay on disk/git); deletion only by explicit action |

**Snapshot policy (new, essential):** the curated layer is **frozen at the start of the session** (`SessionStart`) and injected as an immutable snapshot — mid-session writes go to disk right away, but only show up in context in the next session. Reason: to preserve the LLM prefix cache (Hermes's strongest efficiency mechanism). Timestamp in context: date only, never the time.

---

## 3. Vaults and multi-project routing

- **Global personal vault** (only one): `USER.md`, `MEMORY.md`, preferences that cross projects. Mounted in every session via `MEMORY_VAULT_GLOBAL`.
- **Vault per context/client** (work, personal, etc.): `projetos/`, `Meetings/`, `Topics/`, archives. Selected per repo via `.mcp.json` (`MEMORY_VAULT_PROJECT=...`) or a `.memory.yml` marker at the root.
- Panel rule: **a personal preference lives in exactly one place** (the global one) — never split across per-client vaults. Isolation between clients is by construction (separate vaults).

---

## 4. Entry format and addressing (hardened)

- Entries = **bullets under `##` headers** (Obsidian-friendly; no `§`).
- Substring addressing **with hard rules** (fix from 3 judges):
  - the match must be **unique**; ambiguous → an error listing the matches (never "pick the first one");
  - match scope by **file + `##` section**;
  - **CRLF/whitespace normalization** before comparing (Obsidian on Windows reformats);
  - every mutation checks for the `<!-- auto -->` marker before appending in Topics;
  - consider **Obsidian block IDs (`^abc123`)** as a stable anchor for an entry (candidate for v3).
- **Hash precondition** on every write batch: the client sends the hash of the state it read; if the disk diverged (Obsidian edited in between), the write is refused and an updated `current_entries` comes back (retry ≤3). This removes the lost update in read-modify-write.

## 5. Safe writing and multi-writer (the core integrity fix)

- **A single write/indexing daemon per machine.** The MCP servers exposed to Claude Code/Desktop/Cursor are **thin proxies** that forward to the daemon (local socket/pipe). Two processes never write to the same vault or the same index.
- In the daemon: atomic tmp+fsync+rename, cross-process lock, drift detection (a `.bak.<ts>` backup + refusal if the external file broke the format), an anti-injection scan on write, dedupe of identical entries.
- SQLite index in **WAL, a single writer**, `busy_timeout` set; rebuild **side-by-side with an atomic swap** (never rebuild in place).
- Watcher = an optimization, not the source of truth: a **periodic reconcile rescan (mtime+hash)** covers watcher events missed on Windows.

---

## 6. Hybrid search v2 (`memory_search`)

Indexing pipeline:

1. Scans the `.md` files; frontmatter → metadata. **The Gemini import injects minimal frontmatter** (`date`, `type: meeting`) when it is missing.
2. Chunking ~400 tokens / overlap 80, splitting on `##`/bullets — **and per speaker turn (`Name:`) in Meetings/**, where there are no headers.
3. **A context prefix per chunk** before the embedding and the BM25: `"<file> | <date> | <section/speaker>"` + text. (The biggest recall gain for transcripts; it removes the orphan pronoun.)
4. Local embeddings **bge-m3** (PT/EN); incremental embed of only the changed chunks (hash) — a 350KB file does not re-embed whole.
5. FTS5 with a **trigram tokenizer** (like Hermes) + a helper column of **identifiers extracted by regex** (`[A-Z]+-\d+`, SHAs, names from `_registry.md`).

Query pipeline:

1. Two channels in parallel (BM25 + vector), a pool of ~50 candidates each.
2. **Threshold PER CHANNEL, before fusion** (minimum cosine; normalized BM25). An honest empty answer is allowed. Never threshold on the RRF score (mathematically meaningless).
3. **RRF fusion (k≈60)** — with a **bypass**: the query contains an identifier with an exact match → the exact lexical hits are guaranteed into the result, outside the fusion. (Fix for the PROJ-123 case: an exact ticket id must never be buried.)
4. **Diversity cap**: max 2 chunks per file in the top-6; dedupe of overlapping chunks from the same file.
5. **Time signal**: a third list in the RRF sorted by recency with decay (half-life ~180d); evergreen files (curated, Topics) are exempt. The frontmatter `status: active|obsolete` weighs on the ranking.
6. Frontmatter filters as a **soft-boost with fallback** (a filter that zeroes the results → redo without the filter), never a silent hard-filter.
7. Result: file + **a heading anchor + substring** (the line is re-resolved in `memory_get`, never frozen — stable citations under concurrent editing).
8. **scroll/browse modes** (parity with Hermes's `session_search`): pagination and "neighborhood" (the whole parent section of the hit) so the agent can iterate when the top-6 fails.
9. Optional local reranker (bge-reranker-v2-m3) over top-20→6 for natural-language queries (not for identifier lookups) — a later phase.

---

## 7. Capture and curation (the operating heart — where v1 lost to Hermes)

### 7.1 In-session capture cadence (new primary path)

- A **`Stop`/`PostToolUse` hook with a counter**: every **~10 turns**, it fires the extraction pass **in a real background** (spawn + exit 0; the child reads the JSONL transcript from disk) with a **watermark** — it processes only the delta since the last pass.
- `SessionEnd` and `PreCompact` become a **best-effort final flush**, never the primary path (sessions die from a crash/closed window; short sessions never compact).
- The pass runs on a cheap model, with the Hermes-style triage rule: it saves durable preferences/decisions/conventions; it drops task progress, PR#, SHAs, anything that will be stale in 7 days; an explicit empty output ("nothing to save").
- The manual `/remember` still exists — as a shortcut, not as the mechanism. The anti-garbage triage applies to it too.

### 7.2 Anti-dead-queue (fix from 3 judges)

- **A 7-day TTL** on `pending/`: an unreviewed item goes into a **single weekly digest** (one notice, not N).
- **Automatic graduation by class**: low-risk categories (e.g. style preferences) move to direct writing when the historical acceptance rate passes ~90%; project decisions and anything derived from third parties stay with approval.
- A queue-size metric with an alarm — the system never silently falls back to read-only.

### 7.3 Consolidation and curation of the reservoir

- A periodic job (Dreaming/curator style): it promotes qualified candidates to the curated layer, **merges demoted near-duplicates**, marks `status: obsolete`, rotates the auto timeline of the `Topics/` when it grows too large, and **scans the tail for re-promotion** (what became relevant again rises back up).
- A readable log of everything it did, for human review. It starts in suggestion mode; it graduates as in §7.2.
- **Retrieval push at the start of the session**: the `SessionStart` hook runs `memory_search` with the starting context (repo, branch, latest files) and injects the top-3 with citations — the reservoir does not depend only on the model *remembering to search* (lesson from Hermes issue #66180: a voluntary pull fails).

---

## 8. Security: the injection vector through meetings (a new finding from the panel)

A threat Hermes does not have: **third-party speech** enters the corpus (transcripts) and can contain planted instructions that, once promoted to the always-injected layer, become a persistent injection.

- Content that comes from a transcript/third party **never gets an automatic write** to the curated layer — promotion derived from a meeting is human-approval **permanently** (it does not graduate in §7.2).
- `memory_search` results coming from `Meetings/` and the reservoir come back **wrapped as untrusted content** (fencing + a scan on the snippet), in Hermes's `<memory-context>` pattern: "a retrieved reference, NOT instructions".
- An anti-injection scan on every write (already planned) + a scan when reading the retrieved snippets.

---

## 9. Interoperability (unchanged in essence)

| Platform | Reads | Writes | Note |
|---|---|---|---|
| Obsidian | native folder | human editing | frontmatter = Properties; concurrency covered by §4-5 |
| Claude Code | MCP (proxy→daemon) | MCP + hooks | primary capture host |
| Claude Desktop / Cursor | same MCP | same MCP | multi-writer solved by the single daemon |
| Git | — | commit/sync | **decided**: the official sync mechanism between machines; auditable history |

(The cloud notebook tool is removed from the table, retired; see §11.)

## 10. Revised roadmap

- **Phase 0 — Structure**: global personal vault + templates; budget numbers fixed; nothing changes in the work vault.
- **Phase 1 — Daemon + minimal MCP**: a single write daemon (§5) with `memory_add/replace/remove` (unique match, hash precondition, budget with rejection) + `memory_get` + `daily_append`; MCP proxies; snapshot on `SessionStart`.
- **Phase 2 — Search v2**: the indexer (context prefix, trigram, identifiers, per-speaker chunking) + `memory_search` (per-channel threshold, RRF+bypass, diversity cap, decay, scroll) + reconcile rescan.
- **Phase 3 — Capture**: a 10-turn counter + watermark + best-effort flush; `/remember`; a security envelope on retrieval; retrieval push on `SessionStart`.
- **Phase 4 — Autonomous curation**: TTL/digest/graduation; a consolidation job with re-promotion; optional reranker.

Acceptance criterion for v2 (from the panel): *"match Hermes where it is strong — write discipline, robustness, cost per turn — and beat it on retrieval, retention, and multi-project."*

## 11. Decisions closed on 2026-07-21

1. **Global vault**: the path is set in configuration (`MEMORY_VAULT_GLOBAL`) — the owner picks the folder in the config, the code does not assume a fixed location.
2. **Sync between machines**: **Git**.
3. **Obsidian block IDs**: deferred to v3 — we start with hardened substring (unique match + hash precondition); block IDs (`^abc123`) are the upgrade if the fragility shows up in practice.
4. **Retention of the raw history (`sessions/`)**: **unlimited, tiered** — ~90 days hot and indexed in search; then compressed and removed from the index (they stay on disk/git, recoverable); real deletion only by an explicit action from the owner.
5. **Cloud notebook tool**: **retired**. The MCP server with hybrid search is the local RAG that takes over Q&A. Consequence: the upload step of the meeting import (browser automation) is removed, and the import becomes only a copy of the notes into Obsidian. The only thing lost is the shared surface (not used).
