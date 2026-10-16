-- Full index DDL (section 6 of the plan). Applied whole when
-- user_version = 0; future changes land as numbered migrations.

-- meta: schema version, active embedding model, generation.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- files: one row per .md file.
-- origin is the single source of trust; trust is derived from it (critique B2).
CREATE TABLE files (
  id            INTEGER PRIMARY KEY,
  vault         TEXT NOT NULL,                 -- 'global' | 'work' | ...
  path          TEXT NOT NULL,                 -- relative, with '/'
  path_lower    TEXT NOT NULL,                 -- lower(path), uniqueness on NTFS
  layer         TEXT NOT NULL,                 -- 'curated'|'reservoir'|'raw'
  doc_type      TEXT,                          -- meeting|topic|person|worklog|curated|daily|session
  doc_date      TEXT,                          -- ISO, from frontmatter or derived
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
  scanner_version INTEGER NOT NULL DEFAULT 0,  -- reindex only what is needed when the rule changes
  indexed_at    INTEGER NOT NULL,
  is_deleted    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (vault, path_lower)
);
CREATE INDEX ix_files_mtime ON files(vault, mtime_ns);
CREATE INDEX ix_files_type  ON files(doc_type, status);

-- chunks: unit of retrieval.
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
  tier           TEXT NOT NULL DEFAULT 'processed', -- 'curated'|'processed'|'raw' (density label, ranking only)
  inj_flags      TEXT NOT NULL DEFAULT '',    -- csv of rule ids from the scan
  created_at     INTEGER NOT NULL,
  UNIQUE (file_id, ordinal)
);
CREATE INDEX ix_chunks_hash ON chunks(chunk_hash);
CREATE INDEX ix_chunks_file ON chunks(file_id);

-- embeddings: keyed by (chunk_hash, model). Vector already normalized, cosine becomes a dot product.
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

-- Triggers AI/AD/AU keep the two FTS tables in sync with chunks.
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, context_prefix, body, identifiers)
    VALUES (new.id, new.context_prefix, new.body, new.identifiers);
  INSERT INTO chunks_trigram(rowid, body, identifiers)
    VALUES (new.id, new.body, new.identifiers);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, context_prefix, body, identifiers)
    VALUES ('delete', old.id, old.context_prefix, old.body, old.identifiers);
  INSERT INTO chunks_trigram(chunks_trigram, rowid, body, identifiers)
    VALUES ('delete', old.id, old.body, old.identifiers);
END;
CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, context_prefix, body, identifiers)
    VALUES ('delete', old.id, old.context_prefix, old.body, old.identifiers);
  INSERT INTO chunks_trigram(chunks_trigram, rowid, body, identifiers)
    VALUES ('delete', old.id, old.body, old.identifiers);
  INSERT INTO chunks_fts(rowid, context_prefix, body, identifiers)
    VALUES (new.id, new.context_prefix, new.body, new.identifiers);
  INSERT INTO chunks_trigram(rowid, body, identifiers)
    VALUES (new.id, new.body, new.identifiers);
END;

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

-- There is no `pending` table: the review queue was removed on 2026-07-28. A
-- captured item is either written straight to memory or discarded, so nothing
-- waits here for a decision. Databases created before that date drop the old
-- table in migration 002.

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

-- embed_cache: reuses the vector of an identical chunk (file moved, duplicate text).
CREATE TABLE embed_cache (
  chunk_hash TEXT NOT NULL, model TEXT NOT NULL, vec BLOB NOT NULL,
  last_used INTEGER NOT NULL, PRIMARY KEY (chunk_hash, model)
) WITHOUT ROWID;

CREATE TABLE index_log (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL,
  action TEXT NOT NULL, path TEXT, detail TEXT
);
