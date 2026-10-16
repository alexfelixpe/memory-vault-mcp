# Implementation plan, portable personal memory (v1)

> **Changed after this plan was written (2026-07-28): the review queue is gone.**
> This document still describes it, and that part is now history, not current
> behaviour. Read it as the record of what was built, not as a description of
> what runs today.
>
> What changed: capture keeps working exactly as written below, up to the point
> where a candidate is decided. From there a candidate has only two outcomes. It
> is auto-promoted into the curated layer through the normal write pipeline, or
> it is discarded on the spot and written nowhere. Removed with the queue:
> `vault/pending/` (`queue.jsonl`, `INBOX.md`), the SQLite `pending` table (see
> section 6; dropped by migration `002_drop_pending.sql`), the `pending.list` and
> `pending.decide` daemon methods, the `memory pending` command, the seven-day
> TTL, the weekly digest in `vault/digests/`, the queue size alarm, and the
> Wilson-bound graduation described in sections 9 and 10 (auto-promotion by class
> and confidence had already replaced it in Increment 6). The backup job (called curation until 2026-09-09) keeps
> only the local Git commit of the vault.
>
> Two rules in this plan did NOT weaken. Third-party content still never enters
> the curated layer on its own; with the queue gone, the block in the write
> pipeline is now unconditional, because the human-approval path that could
> bypass it no longer exists.

A build document. It closes the seams between the six review reports and the completeness critique. Where the reports contradict each other, the choice is marked with the reason in one line. Where the critique knocked down a claim, the text is already corrected.

Base: `portable-memory-architecture-v2.md`. Fixed stack: Node plus TypeScript, `better-sqlite3` with FTS5, Windows 11 as the primary platform. The code and the global vault live in one neutral repo, `memory-vault`, final decision of 2026-07-21 (neutral on purpose: the system belongs to no client).

---

## 1. What we will build, in one page

A personal long-term memory system that runs entirely on the owner's machine. The source of truth is Markdown files in Obsidian vaults, editable by a human. A single process (the daemon) writes to those files, keeps a SQLite index, and answers searches. Claude Code talks to the daemon through a thin MCP server (proxy) and through session hooks.

The system does three things. First, local hybrid search: it joins word search (BM25) with meaning search (embeddings) over meetings, project notes, and the daily log, and returns the file, the section, and the chunk. Second, always-present curated memory: at the start of each session it injects a small block with the user's preferences, decisions, and conventions, frozen so it does not break the model cache. Third, automatic capture: every ten turns a cheap model reads the transcript, pulls out durable facts, and queues candidates for review.

What does not exist today is the sum of this in one place. Today the owner has Obsidian search (word only), a cloud notebook tool (which will be retired), and manual discipline. The new system delivers offline meaning search, injected memory with a size budget, and capture that does not depend on the owner remembering to save.

Delivery order: search first (read-only, corrupts nothing), then write, then capture, then autonomous curation.

---

## 2. Closed technical decisions

| Decision | Choice | Rejected alternative | Reason in one line |
|---|---|---|---|
| FTS5 BM25 channel | Table `chunks_fts` with `unicode61 remove_diacritics 2 tokenchars '-_/.'` | `trigram` as the BM25 channel (plan, storage, build) | Trigram ranks character similarity, not word similarity, and degrades natural search (critique A1, D2). |
| Substring channel | A second table `chunks_trigram`, only for a partial fragment and anchor re-resolution | A single index for everything | Substring is a legitimate use, but separate from ranking. |
| FTS5 external mode | External content: `content='chunks', content_rowid='id'` | `content=''` called external (storage) | `content=''` is contentless; external content lets you read the text back and use snippet (critique A5, D3). |
| What the precondition hash runs on | `canonicalize()`: CRLF to LF, BOM removed, NFC, no lowercase | `normalizeForMatch` with `toLowerCase` (mcp-and-hooks) | Lowercase in the hash makes two different versions collide and allows a lost update (critique D1). |
| Level of the precondition hash | Three levels: `sectionHash` and `entryHash` for add/replace/remove, `fileHash` only for a structural operation | Whole-file hash (mcp-and-hooks, capture) | A whole-file hash makes any Obsidian edit invalidate all writes of the session (critique A3). |
| Budget overflow, terminal outcome | Attempts 1 and 2 return `current_entries` for the model to consolidate; attempt 3 runs a deterministic `forceConsolidate()` and writes | Always give up (mcp-and-hooks) or always force (capture) | The model has cheap semantic context on the first two; the third guarantees termination (critique A2). |
| SQLite index swap | Directories `gen-NNNNNN/` plus a `CURRENT` file; the real switch is in memory | Rename `<vault>.db.new` over `<vault>.db` (search, build) | On Windows you cannot rename an open `.db`, and the rename leaves `-wal`/`-shm` orphaned (critique A4, D7). |
| Write serialization | An in-memory serial queue in the daemon, key = absolute file path | `proper-lockfile` per batch (capture, build) | With a single daemon the intra-machine lockfile is redundant and Obsidian does not respect it (critique A6). |
| Daemon mutual exclusion | The exclusive named pipe is the mutex; whoever gets `EADDRINUSE` exits with code 0 | Win32 mutex (needs N-API) or a PID lockfile | The pipe dies with the process, leaves no orphan lock, and is already the RPC channel (mcp-and-hooks, storage). |
| Proxy-to-daemon transport | Windows named pipe, `net.connect({ path })` | A TCP port on loopback | The pipe has the owner's ACL by construction, no port, no firewall (mcp-and-hooks, build). |
| Daemon startup | Spawn on demand by the first proxy, `detached`, `stdio: 'ignore'`, `windowsHide: true`, `unref()` | A Windows Service or Scheduled Task | It runs with the right identity and updates together with the proxy (storage, build). |
| Where `daily/` lives | In the global vault | In the project vault (build and mcp-and-hooks disagreed) | The daily log is personal and crosses projects; `daily_append` does not route by project (critique A7). |
| Trust model | The `origin` column as the source; `trust` derived from it | `is_trusted`/`layer`/`trust` as competing synonyms | A single concept, the most restrictive by default (critique B2). |
| Origin of a captured fact | Stamped deterministically by the JSONL parser; `tool_result` becomes `third_party_derived` | Self-declaration by the cheap model (capture) | A compromised model forges its own provenance (critique A10, security). |
| Untrusted-content envelope | A single tag `<untrusted-memory nonce="...">` with breakout neutralization and a warning before and after, in an `envelope.ts` module | Varied trust tags and values (`memory-context`, `trust="low"`) | The fence only holds if it is consistent and breakout-proof (critique A8, security). |
| Injection block on write | Only `inj.persist` and `inj.exfil` block, only in the curated layer, only when `origin != human_direct` | Broad block on any imperative (mcp-and-hooks) | A high false-positive rate would refuse the owner's legitimate memory (critique A9, security). |
| Default embedding model | `Xenova/multilingual-e5-small` (384 dim, prefixes `query:`/`passage:`) | `bge-m3` (568M) as default (plan) | bge-m3 holds 1.5 GB of RAM permanently and indexes in hours; e5-small runs in tens of ms (critique B8). |
| Where the embedding runs | A separate `child_process` worker over stdio JSONL | Inside the daemon | An ONNX crash does not bring down the write, and RAM becomes intermittent. |
| Vector search | Brute force in memory over a contiguous `Float32Array` | `sqlite-vec` | Up to ~50 thousand chunks the scan costs less than embedding the query; sqlite-vec is one more native dependency. |
| Vault and index | Vault in any folder; the SQLite index always in `%LOCALAPPDATA%` | The index inside the vault | A file syncer corrupts the WAL; the index is rebuildable. |
| Turn counter | Counts only on the `Stop` event | Counting also on `PostToolUse` | Counting on PostToolUse turns ten turns into ten tool calls (critique, minor note). |
| MCP call in `.mcp.json` | `node` plus the absolute path of the `.js` | `"command": "memory-mcp"` | Claude Code spawns without a shell; without a shell Windows does not apply PATHEXT and gives ENOENT (critique, build). |
| Vault `.gitattributes` | `*.md text eol=lf` forced | `* text=auto eol=lf` | `text=auto` lets git decide and threatens hash stability across machines (critique, minor note). |
| Packaging | The npm `.cmd` shim via `npm i -g .`, three bins | Generate an `.exe` with pkg | The `.exe` unpacks the native binary to disk and reintroduces the ABI problem. |

---

## 3. Decisions closed with the owner (2026-07-21)

These questions were open in the first version of this document. All were decided in conversation on 2026-07-21.

1. **Triage model credential: OpenRouter, with the owner's existing key.** Capture reads the transcript and calls a cheap model via OpenRouter (OpenAI-compatible API; the exact model is configurable, start with a Haiku-class model). The key goes in `%APPDATA%\memory\config.yml`, outside any Git. "Local-only" applies to the data, not to the triage LLM. Cost per pass: input of 6k to 25k tokens.

2. **`sessions/` goes to Git, with mandatory redaction.** The v2 plan decision is kept. Hard consequence: every transcript goes through `scanSecrets()` with masking before entering the vault (see section 10 and Increment 5). The original value never reaches the repo.

3. **Default embedding model: `multilingual-e5-small`.** `bge-m3` stays behind a flag for anyone with spare RAM. Changing the model means re-indexing, not rewriting.

4. **Direct writing to both vaults from the start.** The `write: guarded` mode for the work vault was offered and refused. Safety belt: `.bak` before every mutation, hash precondition, and the T1 test as a release blocker for Increment 4.

5. **Paths.** Global vault (new): `vault/` inside the `memory-vault` repo. Work vault (already existing, do not move it): wherever it already lives on disk, pointed at by config. The work vault becomes its own private Git repo; the global one is versioned by the `memory-vault` repo itself.

6. **Windows Defender exclusion: yes, in the installer.** `install-windows.ps1` adds the vault and `%LOCALAPPDATA%\memory` to the exclusions, showing the command before asking for elevation (once).

What never goes to any Git: the SQLite index and the models (`%LOCALAPPDATA%\memory\`), the `config.yml` with the keys (`%APPDATA%\memory\`), the client denylist, `.bak` backups, and quarantine.

---

## 4. Repo layout

A single npm package in `memory-vault/memory-daemon/`, three bins. The `memory-vault` repo is neutral (not tied to a client) and also carries the global vault in `vault/`.

```
memory-vault/memory-daemon/
  package.json                 3 bins: memoryd, memory-mcp, memory
  tsconfig.json                NodeNext, strict, noEmit for editor and tests
  tsconfig.build.json          emits dist/ with sourcemaps
  vitest.config.ts             2 projects: unit and integration (integration sequential)
  .nvmrc                       pins the better-sqlite3 ABI
  .npmrc                       engine-strict=true
  .gitignore                   dist/, node_modules/, .models/, config/denylist-terms.txt

  scripts/
    install-windows.ps1        npm ci, build, npm i -g ., creates %APPDATA%\memory\
    fetch-model.ts             downloads the embedding model ONNX into .models/
    print-mcp-json.ts          prints the .mcp.json block with paths already resolved
    scan-corpus.ts             false-positive baseline of the scan over the current vault

  src/
    core/                      pure, no network I/O, shared by all
      config.ts                loads config.yml + .memory.yml + env, validates with zod
      paths.ts                 appDataDir(), localAppDataDir(), toVaultRelPosix()
      ipc-address.ts           pipeName(): the single pipe-name formula
      text/eol.ts              detectEol, stripBom, applyEol
      text/canonicalize.ts     canonicalize(): the single base of the hashes
      text/normalize.ts        normalizeForMatch(): aggressive, only for comparing
      frontmatter.ts           gray-matter, preserves key order
      markdown/sections.ts     parser for "##" and bullets, resolveEntry()
      markdown/chunker.ts      chunk ~400 tokens, overlap 80
      identifiers.ts           ID regex plus the _registry.md vocabulary
      hash.ts                  sha256 over canonicalize()
      atomic-write.ts          tmp + fsync + rename with retry + .bak backup
      budget.ts                measureCurated(), enforce()
      envelope.ts              wrapUntrusted(), neutralizeEnvelopeBreakout()
      provenance.ts            Origin, parseBulletSrc(), mergeOrigin()
      logger.ts                pino, rotating file, always on stderr in the hooks

    security/
      scan-injection.ts        scanInjection(), versioned rules
      scan-secrets.ts          scanSecrets(), redact()
      denylist.ts              loads config/denylist-terms.txt (gitignored)

    index/
      db.ts                    opens SQLite, pragmas
      schema.sql               full DDL, applied at boot
      migrations/001_init.sql  numbered migrations, user_version
      indexer.ts               indexFile(), removeFile(), incremental embed
      reconcile.ts             rescan mtime+size+hash, source of truth
      watcher.ts               chokidar, optimization, not the source of truth
      rebuild.ts               rebuild per generation, swap via CURRENT
      search/
        lexical.ts             chunks_fts unicode61, normalized bm25
        trigram.ts             chunks_trigram, substring and re-resolution
        vector.ts              brute-force cosine over Float32Array
        temporal.ts            list by recency, half-life 180d
        fuse.ts                RRF k=60, identifier bypass, per-file cap
        search.ts              orchestrates channels, per-channel threshold, scroll, browse

    embed/
      embedder.ts              Embedder interface
      worker.ts                child_process, stdin/stdout JSONL, loads ONNX once
      client.ts                pool of 1 worker, queue, restart, timeout, warmup

    daemon/
      main.ts                  bin memoryd, single instance via named pipe
      server.ts                net.createServer over the pipe, NDJSON framing
      protocol.ts              Req/Res types, versioned
      write-pipeline.ts        the single write order (section 7)
      promote.ts               canPromote(), the single door to the curated layer
      handlers/                get, mutate, search, daily, snapshot
      capture/                 read-delta, extractor, triage.system.md
      backup/                  vault-backup.ts (Git commit of the vault; called curation until 2026-09-09)
      supervisor.ts            reconcile, consolidation job

    mcp/
      index.ts                 bin memory-mcp, thin proxy, stdio
      client.ts                connects to the pipe, ENOENT starts the daemon
      tools.ts                 registration of the 6 tools with a zod schema

    hooks/
      session-start.ts         frozen snapshot + retrieval push
      turn-counter.ts          Stop hook, counts and queues capture
      session-end.ts           best-effort flush, never primary
      transcript.ts            reads the JSONL with a watermark per session_id

    cli/
      memory.ts                bin memory: index, search, doctor, status

  test/
    helpers/tmp-vault.ts       makeTmpVault(), CRLF and BOM variants
    helpers/fake-embedder.ts   deterministic embedder without ONNX
    fixtures/                  synthetic vault, fictitious names
    unit/
    integration/
```

The pipe name has a single formula, in `core/ipc-address.ts`, imported by the proxy, the daemon, and all the hooks: `\\.\pipe\memory-vault.v1.<username>`, with `<username>` from `os.userInfo().username`. A divergent formula between hook and proxy breaks the product silently (critique B6).

---

## 5. MCP tool contracts

A closed list of six tools (critique B9). `memory_browse` becomes a mode of `memory_search`; `memory_demote` becomes a flag of `memory_remove`; `memory_review` is a human action in the CLI, not an agent tool. Each tool is a description the model reads every turn, so the list stays lean.

The model never sends a disk path. It sends a file enum. That kills path traversal.

```ts
type MemoryFile = 'user' | 'memory' | 'project' | { archive: string };

type ToolEnvelope<T> =
  | { ok: true;  data: T }
  | { ok: false; error: { code: string; message: string; hint: string; [k: string]: unknown } };
```

Hard error rule: the message has three parts in order (what happened, the data to fix it, the exact next call). An error without an actionable `hint` is a bug.

**memory_get.** Reads the raw curated layer with the hash needed to write. It does not require a live daemon: it is a disk read and can be served by the proxy if the pipe is dead.
- Input: `file`, `section?`, `citation?` (from memory_search: `{ path, heading, match }`), `neighborhood?` (`'entry'|'section'|'file'`, default `'section'`).
- Output: `{ file, path_hint, hash, budget: { used_chars, limit_chars }, sections: [{ name, entries: [{ text, line }] }], trust }`. The `hash` is the `sectionHash`/`fileHash` that the write must return.
- Errors: `FILE_NOT_FOUND`, `CITATION_UNRESOLVED`, `PATH_OUTSIDE_VAULT`.

**memory_add, memory_replace, memory_remove.** Three names over a single batch engine. Consolidating (deleting three bullets and writing one) must be a single call, otherwise the intermediate state overflows the budget.
- Common schema: `{ file, expect: { sectionHash, fileHash?, entryHash? }, ops: Op[1..20], reason? }`. The tool name validates the main intent (`memory_add` requires at least one `add` op), but the batch accepts mixed ops.
- add `Op`: `{ op:'add', section, text (1..400, one sentence), after?, source:'user'|'inferred'|'third_party' }`.
- replace `Op`: `{ op:'replace', section, match (3..200), text }`.
- remove `Op`: `{ op:'remove', section, match, demote?: boolean }`. `demote:true` deletes from the curated layer and appends to `<file>-archive.md`.
- Success output: `{ file, new_hash, budget: { used_chars, limit_chars, pct }, applied: [...], skipped: [...], visible_next_session: true }`. `visible_next_session` warns the model that the write does not appear in this session.
- Main errors: `STALE_HASH` (returns the full `current_entries` and `current_hash`), `BUDGET_EXCEEDED` (returns `current_entries`, `demotion_candidates`, `over_by_chars`, `attempt`, `attemptsLeft`, `final`), `AMBIGUOUS_MATCH` (lists the candidates with `index`, never picks the first), `NO_MATCH` (returns the section or the neighbors by similarity), `SECTION_NOT_AUTO` (missing `<!-- auto -->`), `THIRD_PARTY_BLOCKED`, `INJECTION_SUSPECTED` (only `inj.persist`/`inj.exfil` in the curated layer), `SECRET_BLOCKED`, `DAEMON_UNAVAILABLE`.

**memory_search.** Hybrid search over the whole personal history.
- Input: `query (2..500)`, `k?` (default 6), `scope?` (`'all'|'curated'|'reservoir'|'meetings'|'daily'`), `filters?` (soft-boost), `mode?` (`'topk'|'scroll'|'browse'`), `cursor?`, `expand?` (`'none'|'section'`).
- Output: `{ query_kind:'identifier'|'natural', hits: [{ rank, path_hint, heading, headingSlug, match, snippet, date, trust, channels, scores }], empty_reason?, cursor?, filters_relaxed?, degraded? }`.
- A snippet from `Meetings/` or the reservoir comes back fenced by the untrusted envelope and goes through the scan.
- Degradation: if the embedder did not load, it answers only with BM25 and marks `degraded:'lexical_only'`. It never fails entirely.
- Errors: `INDEX_UNAVAILABLE`, `QUERY_TOO_SHORT`.

**daily_append.** Appends a line to the day's log. No budget, does not enter the automatic context.
- Input: `text (1..1000)`, `kind?` (`'fact'|'decision'|'pending'|'waiting'`), `date?`, `tags?`. No `project`: the daily lives in the global vault (critique A7).
- Output: `{ path_hint, line, created_file }`.
- No `expect_hash`: an append to an append-only file has no lost update, the daemon serializes.

---

## 6. SQLite schema (real DDL)

A single `schema.sql`, applied at daemon boot by `migrations/001_init.sql` with `user_version`, independent of the phase (critique B1, C4). The index lives in `%LOCALAPPDATA%\memory\index\gen-NNNNNN\index.db`, never inside the vault.

Mandatory pragmas in `db.ts`:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;   -- with WAL, safe against a process crash
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA temp_store   = MEMORY;
PRAGMA cache_size   = -65536;   -- 64 MB
PRAGMA mmap_size    = 0;        -- SQLite default; set for safety, not the central gotcha
```

Note on `mmap_size = 0`: the SQLite default is already 0 and `better-sqlite3` does not turn mmap on. The line guards against someone turning mmap on later, which would block the removal of old generations. The real swap gotcha is the Defender handles and the `-wal`/`-shm` files, solved by the generation switch (section 2 of the plan, decision A4).

```sql
-- meta: schema version, active embedding model, generation.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- files: one record per .md file.
-- origin is the single source of trust; trust is derived from it (critique B2).
CREATE TABLE files (
  id            INTEGER PRIMARY KEY,
  vault         TEXT NOT NULL,                 -- 'global' | 'work' | ...
  path          TEXT NOT NULL,                 -- relative, with '/'
  path_lower    TEXT NOT NULL,                 -- lower(path), uniqueness on NTFS
  layer         TEXT NOT NULL,                 -- 'curated'|'reservoir'|'raw'
  doc_type      TEXT,                          -- meeting|topic|person|worklog|curated|daily|session
  doc_date      TEXT,                          -- ISO, from the frontmatter or derived
  status        TEXT NOT NULL DEFAULT 'active', -- 'active'|'obsolete'
  is_evergreen  INTEGER NOT NULL DEFAULT 0,    -- 1 = exempt from decay
  mtime_ns      BIGINT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  file_index    TEXT,                          -- NTFS File ID (st.ino), detects rename
  content_hash  TEXT NOT NULL,                 -- sha256 of canonicalize()
  frontmatter   TEXT NOT NULL DEFAULT '{}',
  origin        TEXT NOT NULL DEFAULT 'third_party_derived',  -- restrictive default
  trust         TEXT NOT NULL DEFAULT 'untrusted',
  quarantined   INTEGER NOT NULL DEFAULT 0,
  scanner_version INTEGER NOT NULL DEFAULT 0,  -- re-indexes only what is needed when the rule changes
  indexed_at    INTEGER NOT NULL,
  is_deleted    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (vault, path_lower)
);
CREATE INDEX ix_files_mtime ON files(vault, mtime_ns);
CREATE INDEX ix_files_type  ON files(doc_type, status);

-- chunks: the retrieval unit.
CREATE TABLE chunks (
  id             INTEGER PRIMARY KEY,
  file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  ordinal        INTEGER NOT NULL,
  kind           TEXT NOT NULL,                -- 'header'|'bullet'|'turn'|'prose'
  heading_path   TEXT,
  heading_slug   TEXT,
  speaker        TEXT,                         -- only in Meetings/
  context_prefix TEXT NOT NULL,               -- '<file> | <date> | <section/speaker>'
  body           TEXT NOT NULL,               -- text without the prefix
  anchor_substring TEXT NOT NULL,             -- anchor returned to the client
  identifiers    TEXT NOT NULL DEFAULT '',    -- extracted IDs, UPPERCASE, space-separated
  char_start     INTEGER NOT NULL,            -- offset in the canonical content
  char_end       INTEGER NOT NULL,
  start_line     INTEGER NOT NULL,            -- hint, revalidated on read
  token_count    INTEGER NOT NULL,
  chunk_hash     TEXT NOT NULL,               -- sha256(context_prefix + '\n' + body)
  origin         TEXT NOT NULL DEFAULT 'third_party_derived',
  inj_flags      TEXT NOT NULL DEFAULT '',    -- csv of rule ids from the scan
  created_at     INTEGER NOT NULL,
  UNIQUE (file_id, ordinal)
);
CREATE INDEX ix_chunks_hash ON chunks(chunk_hash);
CREATE INDEX ix_chunks_file ON chunks(file_id);

-- embeddings: keyed by (chunk_hash, model). Vector already normalized, cosine becomes an inner product.
CREATE TABLE embeddings (
  chunk_hash TEXT NOT NULL,
  model      TEXT NOT NULL,                    -- 'multilingual-e5-small' | 'bge-m3'
  dim        INTEGER NOT NULL,                 -- 384 | 1024
  vec        BLOB NOT NULL,                    -- Float32Array little-endian
  embedded_at INTEGER NOT NULL,
  PRIMARY KEY (chunk_hash, model)
) WITHOUT ROWID;

-- Channel 1: real BM25. tokenchars keeps 'PROJ-123' and 'feat/PROJ-123' as a single token.
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  context_prefix, body, identifiers,
  content='chunks', content_rowid='id',
  tokenize="unicode61 remove_diacritics 2 tokenchars '-_/.'"
);

-- Channel 1b: substring, only partial lookup and anchor re-resolution.
CREATE VIRTUAL TABLE chunks_trigram USING fts5(
  body, identifiers,
  content='chunks', content_rowid='id',
  tokenize="trigram remove_diacritics 1"
);
-- AI/AD/AU triggers keep the two FTS in sync with chunks.

-- session_snapshot: freezes the curated layer per session (section 2 of the plan).
CREATE TABLE session_snapshot (
  session_id   TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  body         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  char_count   INTEGER NOT NULL,
  source_first TEXT NOT NULL                   -- startup|resume|clear|compact|fork
);

-- capture_watermark: turn counter and transcript offset.
CREATE TABLE capture_watermark (
  session_id       TEXT PRIMARY KEY,
  transcript_path  TEXT NOT NULL,
  head_sha256      TEXT NOT NULL,              -- sha256 of the first 4096 bytes
  byte_offset      INTEGER NOT NULL DEFAULT 0,
  turns_since_pass INTEGER NOT NULL DEFAULT 0,
  last_pass_at     TEXT,
  status           TEXT NOT NULL DEFAULT 'idle'
);
CREATE TABLE seen_message (
  session_id TEXT NOT NULL, uuid TEXT NOT NULL,
  PRIMARY KEY (session_id, uuid)
) WITHOUT ROWID;

-- pending: projection of queue.jsonl for fast lookup.
-- REMOVED 2026-07-28 with the review queue. It is no longer in schema.sql, and
-- migration 002_drop_pending.sql drops it from any index built before that date.
CREATE TABLE pending (
  id           TEXT PRIMARY KEY,               -- ULID
  text         TEXT NOT NULL,
  class        TEXT NOT NULL,
  target_path  TEXT NOT NULL,
  target_section TEXT,
  source_kind  TEXT NOT NULL,
  origin       TEXT NOT NULL,
  confidence   REAL NOT NULL,
  state        TEXT NOT NULL,                  -- open|accepted|rejected|expired
  proposed_at  TEXT NOT NULL,
  decided_at   TEXT, decided_by TEXT, edited INTEGER NOT NULL DEFAULT 0,
  session_id   TEXT, turn_id TEXT, evidence TEXT
);
CREATE INDEX ix_pending_open ON pending(state, proposed_at);

-- entry_events: history of each entry (created, demoted, promoted, merged, reinforced).
CREATE TABLE entry_events (
  id        INTEGER PRIMARY KEY,
  entry_id  TEXT NOT NULL,                     -- ULID in the bullet comment
  event     TEXT NOT NULL,
  from_path TEXT, from_section TEXT, to_path TEXT, to_section TEXT,
  reason    TEXT, batch_id TEXT, turn_id TEXT, session_id TEXT,
  at        TEXT NOT NULL
);
CREATE INDEX ix_entry_events ON entry_events(entry_id, at);

-- write_log: audit and undo.
CREATE TABLE write_log (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL,
  vault TEXT NOT NULL, path TEXT NOT NULL, op TEXT NOT NULL, section TEXT,
  before_hash TEXT, after_hash TEXT, backup_path TEXT,
  actor TEXT NOT NULL, session_id TEXT
);

-- search_cursors: stable pagination for scroll.
CREATE TABLE search_cursors (
  cursor_id TEXT PRIMARY KEY, query_text TEXT NOT NULL, params_json TEXT NOT NULL,
  hit_ids TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
) WITHOUT ROWID;

-- embed_cache: reuses the vector of an identical chunk (moved file, duplicate text).
CREATE TABLE embed_cache (
  chunk_hash TEXT NOT NULL, model TEXT NOT NULL, vec BLOB NOT NULL,
  last_used INTEGER NOT NULL, PRIMARY KEY (chunk_hash, model)
) WITHOUT ROWID;

CREATE TABLE index_log (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL,
  action TEXT NOT NULL, path TEXT, detail TEXT
);
```

The per-bullet comment (single format, critique B4): `<!-- mem id=<ULID> src:<human|sess|3p> [origin] flags:<...> -->`. `memory_add` always emits the ULID, because demotion by reinforcement needs it. `measureCurated()` and the snapshot builder **strip** this comment before measuring and before injecting: the comment does not count toward the budget and does not go into the context.

---

## 7. Safe writing on Windows (algorithm)

The single order of the write pipeline, in one place (`write-pipeline.ts`, critique B5):

```
1. Enqueue in the daemon serial queue (key = the absolute file path).
2. Re-read the file from disk (a few KB). Never trust the index cache.
3. canonicalize() the content read.
4. Evaluate the hash precondition at three levels, short-circuiting:
     fileHash diverged  -> CONFLICT_FILE
     sectionHash diverged -> CONFLICT_SECTION
     entryHash diverged (if provided) -> CONFLICT_ENTRY
   On conflict, return current_entries already parsed, the new hashes, and attemptsLeft.
5. scanSecrets() over the text to write. Blocks in ALL layers.
6. Client denylist. Blocks in the curated layer and in Topics/projects.
7. scanInjection(). Only inj.persist and inj.exfil block, only in the curated layer, only if origin != human_direct.
8. Simulate the whole batch in memory (resolve matches, apply ops).
9. measureCurated() of the FINAL state against the file budget.
     Within the ceiling: write.
     Above: attempts 1 and 2 return BUDGET_EXCEEDED with current_entries.
            Attempt 3 calls forceConsolidate() and writes.
10. Atomic write: tmp + fsync + rename with retry. .bak backup first.
```

Atomic write, the specifically-Windows part:

```ts
export async function atomicWriteMarkdown(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  // tmp in the SAME directory (rename across volumes is not atomic) and with an
  // extension that does not end in .md (Obsidian ignores it and creates no ghost note).
  const tmp = path.join(dir, `.${base}.pm-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const fd = fs.openSync(tmp, 'wx', 0o666);          // 'wx' never reuses a tmp
  try {
    const buf = Buffer.from(content, 'utf8');
    let off = 0; while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);                                // without this, a power loss leaves a file of zeros
  } finally { fs.closeSync(fd); }
  await renameWithRetry(tmp, targetPath);            // see below
  // There is no directory fsync on Windows (openSync of a folder gives EISDIR).
  // The durability of the directory entry is handled by the NTFS journal.
}

const RENAME_RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
async function renameWithRetry(from: string, to: string): Promise<void> {
  let delay = 12;
  for (let attempt = 0; attempt < 12; attempt++) {   // total window ~3.5s
    try { fs.renameSync(from, to); return; }         // MoveFileExW(REPLACE_EXISTING|COPY_ALLOWED)
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!RENAME_RETRYABLE.has(code) || attempt === 11) { fs.rmSync(from, { force: true }); throw e; }
      await sleep(delay + Math.random() * delay);    // jitter against the Defender scan
      delay = Math.min(delay * 1.8, 500);
    }
  }
}
```

`canonicalize()` is the single base of the hashes. It never hashes disk bytes (critique D1):

```ts
export function canonicalize(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')       // BOM from Notepad and PowerShell 5.1
    .replace(/\r\n?/g, '\n')      // CRLF and lone CR to LF
    .normalize('NFC')             // decomposed vs precomposed accents (Portuguese)
    .replace(/[ \t]+$/gm, '')     // trailing whitespace at end of line
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n*$/, '\n');
}
```

`normalizeForMatch()` is more aggressive (lowercase, removes the bullet marker, emphasis, wikilink, curly quotes, NBSP) and is used **only to compare substrings**, never to hash and never to write.

Windows cases treated as a requirement: a persistent `EACCES` from Controlled Folder Access becomes a typed error `WRITE_BLOCKED_BY_POLICY` with an instruction (a retry only wastes time); reserved names (`CON`, `NUL`, `AUX`) and `:` in a file name are sanitized; a path over 240 chars uses the `\\?\` prefix; case-insensitivity is resolved by `path_lower`. Backup in `<vault>/.memory/backups/<relpath>.<epochms>.bak`, outside the visible vault, retention of the last 20 versions per file.

There is no real mutual exclusion with Obsidian. If the owner has the note open with an unsaved edit and the daemon writes, Obsidian may overwrite it on save. The `.bak` recovers it. The defense is to write little and in batches (a cadence of ten turns).

---

## 8. Hybrid search (pipeline with pseudo-code and default constants)

Default constants, each marked with the model it belongs to (critique B8). Changing the model requires recalibrating all the cosine thresholds:

```ts
export const SEARCH_DEFAULTS = {
  POOL_PER_CHANNEL: 50,
  TOP_N: 6,
  MIN_COSINE: 0.35,          // multilingual-e5-small. With bge-m3 use ~0.50. Calibrate.
  MIN_BM25_NORM: 0.15,       // bm25 normalized min-max within the pool
  RRF_K: 60,
  W_LEXICAL: 1.0, W_VECTOR: 1.0, W_RECENCY: 0.4,
  HALF_LIFE_DAYS: 180,       // evergreen files exempt
  MAX_PER_FILE: 2,
  OVERLAP_DEDUPE_RATIO: 0.5,
  BYPASS_MAX_SLOTS: 3,
  SOFT_BOOST_FACTOR: 0.15,
  OBSOLETE_PENALTY: 0.5,
  TIER_RAW_FACTOR: 0.7,   // fused score multiplier for raw chunks (2026-09-08)
  CURSOR_TTL_MS: 15 * 60_000,
};
// Write constants, also per model:
//   DEDUP_ON_WRITE_COSINE: 0.90 (e5-small; was 0.92 for bge-m3). Calibrate.
//   PUSH_DEDUP_COSINE:     0.88 (e5-small). Calibrate.
```

Query pipeline:

```ts
async function memorySearch(req: SearchRequest): Promise<SearchResponse> {
  const K = { ...SEARCH_DEFAULTS, ...req.tuning };
  if (req.cursor) return pageFromCursor(req.cursor, req.limit ?? K.TOP_N);

  // 1. Extract identifiers from the query itself with the same regex as the indexer.
  const queryIds = extractIdentifiers(req.query);            // e.g.: ['PROJ-123']
  const isLookup = queryIds.length > 0 && req.query.split(/\s+/).length <= 4;

  // 2. Identifier bypass: exact match on the 'identifiers' column, OUTSIDE the fusion.
  //    Without this, the only chunk that cites PROJ-123 loses to two mediocre ones that
  //    appear in both channels.
  let bypass: Hit[] = [];
  if (queryIds.length > 0) bypass = capPerFile(lookupExactIds(queryIds), 1).slice(0, K.BYPASS_MAX_SLOTS);

  // 3. Two channels in parallel. An id lookup does not need the vector one.
  const [lex, vec] = await Promise.all([
    lexicalChannel(req, K),
    isLookup ? Promise.resolve([]) : vectorChannel(req, K),
  ]);

  // 4. Threshold PER CHANNEL, before fusion. Never on the RRF score (it has no scale).
  const lexKeep = lex.filter(h => normalizeBm25(h, lex) >= K.MIN_BM25_NORM);
  const vecKeep = vec.filter(h => h.cosine >= K.MIN_COSINE);
  if (!lexKeep.length && !vecKeep.length && !bypass.length)
    return { hits: [], empty_reason: 'below_threshold' };    // an honest empty result is valid

  // 5. Third list: recency with half-life. Evergreen gets freshness 1.0.
  const union = uniqueById([...lexKeep, ...vecKeep]);
  const recency = [...union].sort((a, b) => freshness(b, K) - freshness(a, K));

  // 6. RRF fusion (k=60). Position = position WITHIN the list, not the channel score.
  const fused = rrf([
    { list: lexKeep, weight: K.W_LEXICAL },
    { list: vecKeep, weight: K.W_VECTOR },
    { list: recency, weight: K.W_RECENCY },
  ], K.RRF_K);

  // 7. Frontmatter soft-boost (never a hard-filter) and obsolete penalty.
  for (const h of fused) {
    let m = 1.0;
    if (req.filters) m += K.SOFT_BOOST_FACTOR * countFrontmatterMatches(h, req.filters);
    if (h.file.status === 'obsolete') m *= K.OBSOLETE_PENALTY;
    if (h.chunk.tier === 'raw') m *= K.TIER_RAW_FACTOR;
    h.score *= m;
  }
  fused.sort((a, b) => b.score - a.score);

  // 8. Overlap dedupe and a cap of 2 per file.
  let ranked = capPerFile(dedupeOverlapping(fused, K.OVERLAP_DEDUPE_RATIO), K.MAX_PER_FILE);

  // 9. Bypass enters guaranteed in the first positions, marked channel='exact'.
  let final = mergeBypassFirst(bypass, ranked, K.TOP_N);

  // 10. Filter fallback: if it zeroed because of the filter, redo without it.
  if (!final.length && req.filters) return memorySearch({ ...req, filters: undefined, _relaxed: true });

  // 11. Security envelope: a snippet outside the curated layer comes back fenced and scanned.
  const hits = final.map(h => toResult(h, { fence: h.file.layer !== 'curated' }));
  return { hits, cursor: saveCursor(req, fused), filters_relaxed: req._relaxed ? ['filters'] : undefined };
}

function freshness(h: Hit, K): number {
  if (h.file.isEvergreen) return 1.0;
  const days = (Date.now() - Date.parse(h.file.docDate)) / 86_400_000;
  return Math.pow(0.5, Math.max(0, days) / K.HALF_LIFE_DAYS);
}
```

Brute-force vectors: a dense contiguous `Float32Array` matrix loaded once at daemon startup, inner product in a loop. 5 thousand chunks cost 3 to 8 ms, noise next to the 200 to 400 ms of embedding the query. Turning point to quantize to int8 or switch to `sqlite-vec`: more than 50 thousand chunks, or RAM above 250 MB, or channel p95 above 60 ms. The `VectorIndex` interface exists from day 1 so the switch is a single class.

Embedder cold-start (critique C2): the `SessionStart` retrieval push has a lexical-only degraded path when the embedder is not warm. The daemon pre-warms the model asynchronously; until it is ready the push uses BM25 plus the identifier bypass.

Semantic dedup on write depends on the embedder (critique C1): in Increment 4 (write) the dedup is only lexical and exact. Cosine dedup only comes in when the indexer exists (Increment 3). The tool does not promise a semantic `duplicate_of` before that.

---

## 9. Capture and curation (prompts, budget, queue)

**Triage extractor.** Runs in the daemon, cheap model, output forced by schema with `tool_choice` over an `emit_triage` tool, revalidated with zod. Input: the transcript `delta` since the watermark (max ~24k tokens, numbered turns) plus the current curated entries to mark duplicates. The prompt (`triage.system.md`) sets the default to DO NOT SAVE, saves only a specific durable fact about the owner, the team, or the stable rules, and drops task progress, PR#, SHA, and anything that becomes stale in seven days.

Deterministic post-validation, before any write:
- `nothing_to_save` with items is a contradiction: drop the pass.
- A volatile-identifier regex (`/\b[A-Z]{2,6}-\d+\b/`, SHA, `PR ?#?\d+`) forces a drop even if the model approved.
- **Origin stamped by the JSONL parser, not by the model** (critique A10): a `user` turn becomes `session_extract`; content that came from `tool_result` becomes `third_party_derived` and never writes automatically. The model's `source_kind` field is a secondary hint.
- `confidence < 0.6` goes to `pending`.
- Dedup: cosine above the model threshold against an existing entry becomes `duplicate`.

**Budget with rejection.** `measureCurated()` counts code points over the canonical text, without frontmatter and without the `<!-- ... -->` comments. The batch is measured against the FINAL state: a `remove` of 300 chars plus an `add` of 250 passes even with the file at the ceiling. Budgets: `USER.md` 1400, `MEMORY.md` 2200, `project` 1500.

Terminal outcome, single flow (critique A2):
- Attempts 1 and 2: return `BUDGET_EXCEEDED` with `current_entries` and `demotion_candidates`. The model consolidates in the same turn.
- Attempt 3: a deterministic `forceConsolidate()` demotes in a fixed order (obsolete, superseded, oldest without reinforcement, longest first) until it fits, writes, returns `ok` with `consolidated: true`. It never returns an error that invites a new attempt.
- If the batch alone overflows the ceiling: `BATCH_TOO_LARGE` with `final: true`. `USER.md` never demotes by budget; an overflow there is always a request for human editing.

The attempt counter per `turnId` stays in the daemon's memory, expires in 30 minutes.

**Anti-dead-queue.** *(Removed 2026-07-28: there is no queue, so there is no dead queue to guard against. A candidate that does not auto-promote is discarded in the same pass.)* The `pending/` queue is an append-only `queue.jsonl` as the truth, plus the SQLite projection, plus an `INBOX.md` view. One file per item is wrong on Windows (antivirus and slow enumeration). Each line is an event (`proposed`, `accepted`, `rejected`, `edited`, `expired`, `digested`). The current state is the last event. Rotation at 5 MB, with a dash in the name, never `:`.

*(Removed 2026-07-28 together with the queue: no TTL, no weekly digest, no size alarm.)* Seven-day TTL: the oldest `open` item becomes `expired` (the text survives in the JSONL and in search). A single weekly digest (`digests/2026-WNN.md`), not one notice per item. `SessionStart` injects a single line, and only if there is an unread digest. Size alarm: above 40 open items or an item older than 21 days, the job stops proposing already-graduable classes and the state is logged, never silently falling back to read-only.

**Automatic graduation by class and vault.** *(Superseded twice. Increment 6 replaced the Wilson bound with immediate auto-promotion on class, origin and confidence. On 2026-07-28 the queue this graduated FROM was removed, so `canPromote()` and its Wilson bound are no longer on any live path. The class list below is still the list that may auto-promote, and the third-party lock is still absolute.)* Eligible: `style_preference`, `flow_convention`, `env_gotcha`. Never eligible: `project_decision`, `hard_constraint`, `person_fact`, and **any `third_party` item or one of origin `third_party_derived`, permanently** (section 8 of the plan). Locked in code, not in config. Threshold: Wilson lower bound at 90 percent, `n >= 20` and `LB >= 0.85`, no rejection in the last ten decisions. Revocation: two rejections in ten after graduating resets the window.

**Consolidation job.** *(As shipped, and after 2026-07-28, this job does one thing: the local Git commit of the vault, with a secret scan on every staged file. The expiry, digest and graduation steps below were never more than the queue's housekeeping and went away with it.)* A timer in the daemon plus a `last_run_at` stamp (the machine hibernates and the timer misses a fire); a Scheduled Task calling `memory backup` is the optional safety belt. Order of steps: reconcile, expiration, deduplication and merge (the merge inherits the **weakest origin** of the two, security critique), decay and obsolescence, tail re-promotion (goes through the budget, never evicts a human entry), Topics rotation, graduation, digest, Git commit without push. A readable log shows the text before and after each change.

**Retrieval push on `SessionStart`.** A query built from repo signals, collected with `execFileSync('git', ..., { timeout: 400, windowsHide: true })`: branch, `diff --name-only`, `log -n 3`, plus the branch's ticket keys. `\` becomes `/` before becoming a term. Fixed budget: max 3 hits, max 220 code points per snippet, **max 900 code points in the block** (chosen over 1200 for being safer for the cache, minor-note critique), max 1 hit per file, dedup against the curated layer by cosine. If nothing passes the threshold, it injects nothing. The block enters together with the snapshot, in the same initial block, so as not to break the prefix cache.

**Frozen snapshot.** Frozen on disk by `session_id`. A `SessionStart` that runs again (`resume`, `compact`) returns the same bytes. Mid-session writes only go to disk, with `visible_next_session: true`. Zero volatile content in the body (no time, branch, SHA, queue count). A `date` attribute, date only. Regression test: run the hook twice with the same `session_id` and a write in between, assert the `sha256` is equal.

---

## 10. Security (envelope, scan, provenance)

**Provenance as the source.** Three values in `origin`: `human_direct`, `session_extract`, `third_party_derived`. `trust` derives: curated, session, untrusted. The origin lives in the frontmatter per file and in the per-bullet comment when it differs from the file (`<!-- src:human -->`, `<!-- src:3p meeting/... -->`). Hard rule: a bullet without a marker in an untrusted file is treated as `third_party_derived`. Absence never means trust.

`canPromote()` is the single door to the curated layer. `third_party_derived` of any class returns `needs_approval` **permanently**: the function does not even read the acceptance rate. The `promote.test.ts` test pins this: with `acceptRate: 1.0` and a thousand approvals, `third_party_derived` still asks for approval. Provenance is sticky: a merge inherits the weakest origin (`mergeOrigin`), otherwise consolidation becomes provenance laundering.

**Untrusted envelope.** An `envelope.ts` module, a single tag `<untrusted-memory nonce="...">`. A per-response nonce (`crypto.randomBytes(4)`) stops the payload from closing its own tag. `neutralizeEnvelopeBreakout()` marks any `</untrusted`, `---8<---`, `<system>`, `[INST]`, `<|im_start|>` in the text before inserting. A warning before and after the block. The curated layer is not enveloped, otherwise the envelope becomes noise. Hard truncation of 1200 chars per chunk in the envelope. `memory_search` always returns trusted first, enveloped last.

**Injection scan.** Regex over normalized text (`NFKC`, removes zero-width and bidi). It runs at three points with different actions: on a curated write only `inj.persist` and `inj.exfil` block, and `flag` only blocks if `origin != human_direct`; on a reservoir write it never blocks, only marks; on read it never removes, only fills `flags` and forces the chunk into the enveloped section. Nothing is deleted. The false-positive rate is high, so only two rules block, only in the curated layer, only for non-human content. The `scanner_version` column allows re-indexing only what is needed when a rule changes. Measure before tightening: `scan-corpus.ts` counts firings per rule in the current vault, and a rule only becomes a `block` with less than 1 percent firing.

**Secret scan.** Runs before the injection scan and **blocks in all layers, including the reservoir**, because a false negative is irreversible (a secret published in Git). High-precision rules by prefix: `sk-ant-`, `ghp_`/`github_pat_`, `AKIA`, `xox[baprs]-`, `BEGIN PRIVATE KEY`, JWT, a connection string with a password, an assignment `SECRET|TOKEN|PASSWORD|API_KEY = value`. Shannon entropy only on a line that already matches an assignment form, never in prose. PII with a domain allowlist. Client denylist in `config/denylist-terms.txt`, loaded at runtime and **outside Git** (the list itself committed would be the leak). The error returned to the MCP never echoes the secret, only `rule`, `line`, and the first four chars.

**Defenses outside the daemon.** The vault `.gitignore` with `quarantine/`, `pending/raw/`, `*.bak.*`, `config/denylist-terms.txt`, `.obsidian/workspace*.json`. `sessions/` IS committed (decision of 2026-07-21), so the defense changes from hiding to redacting: every transcript goes through `scanSecrets()` with masking (the value becomes `[REDACTED:rule]`) before entering the vault, and the untouched raw file stays only outside the vault, in the Claude Code sessions directory. A `pre-commit` hook in the vault calling the same `scanSecrets` as a second barrier. Check on `SessionStart`: if `git remote get-url origin` is outside the allowlist, the daemon refuses the sync.

**Windows that affects the defenses.** Normalize CRLF before any regex (`AKIA...\r` does not match `\b` as expected). Refuse to index a file that is not UTF-8 (UTF-16 passes an ASCII regex without matching). Compare the path with `toLowerCase()` when deciding the layer (`Meetings/` and `meetings/` are the same directory on Windows).

---

## 11. Delivery increments

Reversal from the plan's roadmap: **search (Phase 2) comes before write (Phase 1)**. Search is read-only, corrupts nothing, and retires the cloud notebook tool on day 2. Concurrent writing with Obsidian is the dangerous part and comes later, with the indexer already serving as drift detection.

### Increment 1: lexical search, read-only, no daemon

Starts working: `memory index` scans the vault and builds the SQLite; `memory search` and the `memory_search` tool answer with file, heading, and chunk. `chunks_fts` unicode61 plus an identifiers column plus a context prefix plus a time signal. No embeddings, no daemon, no write. The MCP opens the database in `readonly`.

Files born: `core/*` (config, paths, canonicalize, normalize, frontmatter, sections, chunker, identifiers, hash), `index/db.ts`, `index/schema.sql`, `index/indexer.ts`, `index/reconcile.ts`, `index/search/{lexical,trigram,temporal,fuse,search}.ts`, `mcp/*`, `cli/memory.ts`.

Manual verification: `memory index --vault work` shows the count in under 30 seconds; `memory search "PROJ-123"` brings the right Work Log and meetings in the top-3; in Claude Code, "what did we decide about tenant isolation" cites the right Topic; compare with Obsidian's `Ctrl+Shift+F` on the same query.

Done criterion: the product's search does not lose to Obsidian's on the test queries. Useful on its own: yes, it is the local RAG that replaces the cloud notebook tool.

### Increment 2: daemon, pipe, proxy, watcher, reconcile

Starts working: the index updates on its own; `memory-mcp` becomes a thin proxy; `memory status` shows uptime, the last reconcile, and the queue size. Single instance through the named pipe. Mandatory boot order: create the pipe before opening the database.

Files born: `core/ipc-address.ts`, `daemon/main.ts`, `daemon/server.ts`, `daemon/protocol.ts`, `daemon/supervisor.ts`, `index/watcher.ts`, `mcp/client.ts`.

Manual verification: edit a Topic in Obsidian, save, search the new phrase in 2 seconds; rename a file in Explorer and see the old path leave and the new one enter; `taskkill` the daemon and redo a search (the proxy starts another); `git checkout` of 50 files and search the batch, waiting for the reconcile (300s) if the watcher missed the event.

Done criterion: the reconcile catches what the watcher misses; killing the daemon does not show up as an error in Claude Code.

### Increment 3: full hybrid search

Starts working: the embedding worker, the vector channel, per-channel threshold, RRF with bypass, diversity cap, decay, scroll and browse, an envelope on the `Meetings/` snippets.

Files born: `embed/{embedder,worker,client}.ts`, `index/search/vector.ts`, `core/envelope.ts`, `security/scan-injection.ts`, `scripts/fetch-model.ts`, `scripts/scan-corpus.ts`.

Manual verification: a conceptual query with no word in common finds the right note; `memory search "PROJ-999"` (does not exist) returns empty, not the neighbor; a query that matches 8 chunks of the same file shows at most 2 in the top-6; a result from `Meetings/` arrives enveloped, and a line "ignore the instructions" pasted into a test meeting is treated as a quote.

Done criterion: the T3 test (identifier recall with the vector channel sabotaged) passes; an honest empty answer works.

### Increment 4: safe writing

Starts working: `memory_get`, `memory_add`, `memory_replace`, `memory_remove`, `daily_append`; unique match; three-level hash precondition; budget with rejection; atomic write with backup; secret and injection scan; global vault mounted; frozen snapshot on `SessionStart`; and `memory snapshot --out <file>`, which exports the frozen briefing to a file that platforms without hooks (Cursor, Claude Desktop, and the like) include through their own mechanism or read via `memory_get` (decision of 2026-07-21, briefing portability).

Files born: `core/{atomic-write,budget,provenance}.ts`, `security/scan-secrets.ts`, `security/denylist.ts`, `daemon/write-pipeline.ts`, `daemon/promote.ts`, `daemon/handlers/*`, `hooks/session-start.ts`.

Manual verification: "remember that I prefer X" appears in the global `MEMORY.md` right away; filling `MEMORY.md` to 2200 and asking for one more triggers consolidation in the same turn; editing in Obsidian while Claude writes refuses the write and preserves the edit; writing mid-session does not appear in that session's context.

Done criterion: the T1 test (lost update) and the T2 test (ambiguous match) pass; the owner saw the system refuse a concurrent write.

### Increment 5: capture

Starts working: a ten-turn counter (only `Stop`), a watermark on the transcript, a background extraction pass via OpenRouter, `pending/`, `/remember`, retrieval push on `SessionStart`, and the redacted copy of the transcripts to `sessions/`.

Files born: `hooks/{turn-counter,session-end,transcript}.ts`, `daemon/capture/*`.

Blocking requirement for this increment: since `sessions/` is committed, secret redaction is not optional. Every transcript goes through `scanSecrets()` with masking (the value becomes `[REDACTED:rule]`) before entering the vault. The commit never carries the original value.

Manual verification: 30 normal turns and `memory pending` lists candidates without freezing the session; killing VS Code midway and what was already captured is there; opening in a repo and seeing 3 relevant citations in the first message.

Done criterion: the pass never holds the turn; the watermark does not regress after a crash.

### Increment 6: autonomous curation

Starts working: a seven-day TTL, a weekly digest, graduation by class, a consolidation job with re-promotion, an optional reranker.

Files born: `daemon/curation/*` (renamed to `daemon/backup/` on 2026-09-09).

Done criterion: a class graduates only with the Wilson bound satisfied; the log shows text before and after each change.

---

## 12. Tests that matter

Every I/O test runs twice, with `eol: 'lf'` and `eol: 'crlf'`. The parametrize is mandatory: it is where Windows breaks. Integration runs in `singleThread` (the daemon is single instance); each test uses a `pipeName` derived from the temporary directory. Versioned fixtures are synthetic; the golden queries run against the real vault via `MEMORY_TEST_VAULT`, skipped in CI.

**T1. Concurrent write loss.** Real daemon, `MEMORY.md` with 3 bullets.
- Case A: read the hash `H`, a direct `fs.writeFile` (simulates Obsidian) adds a 4th bullet, `memory_replace` with `H` returns `STALE_HASH` with a `current_entries` of 4 bullets, and the file is byte-identical to what Obsidian wrote (assert on the hash).
- Case B: repeating with the new hash converges.
- Case C: 20 concurrent `memory_add` from the same initial hash, each with retry up to 3. Assert over the set: 20 distinct bullets, zero lost, and the ones that overflowed failed visibly.
- Case D: starting a second `memoryd` on the same pipe exits with code 0 without opening the database.

**T2. Ambiguous match.** A file with "prefere TypeScript" in two sections.
- `memory_replace({ match:'prefere TypeScript' })` returns `AMBIGUOUS_MATCH` with the 2 candidates and the file intact (assert on hash and mtime).
- The same call with a section scope changes exactly 1 bullet.
- The same bullet saved with CRLF, a double space, and NBSP matches the clean string.
- The same string inside a code fence does not enter as a candidate.
- Zero match returns a suggestion by similarity, never picks the first.

**T3. Identifier recall.** Golden queries with the vector channel sabotaged (a stub that returns 50 irrelevant chunks with a high cosine), the only way to prove the bypass works on its own.
- `"PROJ-123"`, `"PROJ 123"`, `"what did we decide in PROJ-123"`: the chunk with the literal token always in the top-3.
- A short SHA and a name from `_registry.md` (via the controlled vocabulary): same.
- `"PROJ-999"` (does not exist): empty. The negative assert counts as much as the positive ones.
- `"bge-m3"` (hyphen and digit): the trigram cannot slice it to the point of losing it.

**Unit tests without I/O.** Chunker (splitting by `##`, bullet, `Name:` turn), context prefix, identifier regex, RRF, per-channel threshold, diversity cap, decay, `measureCurated`, `normalizeForMatch`, `canonicalize`, injection scan, secret scan, `mergeOrigin`. A deterministic `FakeEmbedder` tests the fusion without ONNX; the real ONNX runs in a smoke test marked by `MEMORY_TEST_ONNX=1`.

**Snapshot stability test.** Run the `SessionStart` hook twice with the same `session_id` and a `memory_add` write in between, assert `sha256(output1) === sha256(output2)`.

**Provenance test.** `promote.test.ts`: `third_party_derived` with `acceptRate: 1.0` and a thousand approvals still returns `needs_approval`. It stops someone from optimizing the rule six months from now.

**Hook bundle test.** Fails if any hook's bundle imports a native dependency (`better-sqlite3`). The hook can only do `net` plus `JSON`.

---

## 13. Risks and cuts

**Risk 1: local embeddings on Windows.** `onnxruntime-node` needs the Visual C++ Redistributable and the model download can fail on a corporate network. Mitigation already in the design: default `multilingual-e5-small`, a separate worker, `@huggingface/transformers` and `onnxruntime-node` in `optionalDependencies`, `env.cacheDir` fixed at `%LOCALAPPDATA%\memory\models`. Cut if it gets tight: `embeddings.enabled: false`. The product delivers lexical search with identifiers, prefix, and a time signal, already better than Obsidian's `Ctrl+Shift+F`. Purely conceptual questions get worse. A visible and reversible cut.

**Risk 2: concurrent writing with Obsidian.** It is the only item that can lose the owner's data. `rename` over an open file fails with `EPERM`/`EBUSY`; Obsidian rewrites the whole file on save; the watcher may fire on a half-written file. Mitigations: hash precondition, serial queue per file, retry with backoff, `.bak` before every mutation, T1 as a blocker. Cut if it gets tight: append-only mode. `daily_append` and `pending/` stay (files only the daemon touches, without read-modify-write). `memory_replace` and `memory_remove` go, where almost all the risk lives. The product becomes "suggest and archive".

**Risk 3: capture via Claude Code hooks.** The JSONL transcript format is not a public contract. The exact behavior of the hooks on Windows is only found out by testing. Mitigations: a tolerant parser that ignores an unknown line; the pass always in the background with an immediate `exit 0`; a watermark by `(session_id, byte_offset)` written only after the pass persists. Cut if it gets tight: only the manual `/remember` and the retrieval push stay (a simple read hook). The ten-turn capture goes, and turns on later without touching the index or the write.

Order of sacrifice if the week becomes half a week: cut 3 first (capture), then 1 (embeddings), and only as a last resort 2 (write). Increment 1 alone already pays for retiring the cloud notebook tool.

**Residual risks the design carries with eyes open.** There is no real mutual exclusion with Obsidian (the `.bak` recovers, but the data is temporarily lost in the file). Two machines with the vault on OneDrive corrupt the vault: Git is the official sync, and the daemon must detect a OneDrive marker in the path and warn on first startup. The cheap extractor reads untrusted tool output and writes candidates: it is the weakest link, closed by the origin stamped by the JSONL and by the output validated by zod.

### VERIFY before coding

1. **npm package versions: VERIFIED on 2026-07-21 against the npm registry.** The critique's suspicion was out of date; the current versions are: `typescript 7.0.2`, `@huggingface/transformers 4.2.0`, `chokidar 5.0.0`, `pino 10.3.1`, `vitest 4.1.10`, `onnxruntime-node 1.27.0`, `better-sqlite3 13.0.1` (requires Node >= 22, pin it in `.nvmrc`), `@modelcontextprotocol/sdk 1.29.0`, `zod 4.4.3`, `gray-matter 4.0.3`. The MCP SDK declares `zod ^3.25 || ^4.0`, so zod 4 is allowed. Pin exactly these in the initial `package.json`.

2. **Hook behavior: VERIFIED against the official docs on 2026-07-21.** `SessionStart` sources: `startup|resume|clear|compact|fork` (the `fork` was missing in the design; include it in `source_first`). The stability of the `session_id` on resume/clear/compact is NOT documented: the design cannot depend on it (it already does not; a new id = a new snapshot). `Stop` fires once per assistant response and receives `transcript_path`, `session_id`, and `cwd` in the input, which confirms the turn counter. Only the empirical test on the machine is left.

3. **JSONL transcript contract: VERIFIED, and the docs are explicit that it is NOT a public contract** ("internal to Claude Code and changes between versions"). The tolerant parser that ignores an unknown line stops being caution and becomes a requirement. The exact fields (`uuid`, `isSidechain`) are only confirmed empirically, per version.

4. **`SessionStart` `additionalContext`: VERIFIED in the docs.** Stdout (and the JSON `hookSpecificOutput.additionalContext`) enters the model context. There is no documented size limit; the snapshot's own budget remains the only protection. The survival of a detached child process on Windows is NOT documented and is an area of known bugs (issues #32183, #32792): the best-effort flush and the idempotent watermark are the defense, never assume the child finishes.

5. **`db.loadExtension` and long paths.** If `sqlite-vec` ever comes in, confirm that `better-sqlite3` loads a native extension on Windows under a path with a space and under the corporate antivirus policy. Until then, brute force does not depend on it.