import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openIndexDb } from '../../src/index/db.js';
import { reconcileVault } from '../../src/index/reconcile.js';
import { indexFile, type IndexerContext } from '../../src/index/indexer.js';
import { memorySearch } from '../../src/index/search/search.js';
import { loadRegistryVocab } from '../../src/core/identifiers.js';
import { makeTmpVault, makeTmpIndexDir, EOL_VARIANTS, type TmpVault } from '../helpers/tmp-vault.js';
import { SYNTHETIC_VAULT } from '../fixtures/synthetic-vault.js';

describe.each(EOL_VARIANTS)('indexer + reconcile (eol=%s)', (eol) => {
  let vault: TmpVault;
  let index: ReturnType<typeof makeTmpIndexDir>;
  let db: Database.Database;
  let ctx: IndexerContext;

  beforeEach(() => {
    vault = makeTmpVault(SYNTHETIC_VAULT, { eol, bom: eol === 'crlf' });
    index = makeTmpIndexDir();
    db = openIndexDb({ rootDir: index.root });
    ctx = { db, vaultName: 'global', vaultRoot: vault.root, vocab: loadRegistryVocab(vault.root) };
  });

  afterEach(() => {
    db.close();
    index.cleanup();
    vault.cleanup();
  });

  it('scans the whole vault and indexes files and chunks', () => {
    const r = reconcileVault(ctx);
    expect(r.indexed).toBe(Object.keys(SYNTHETIC_VAULT).length);
    expect(r.removed).toBe(0);
    const chunks = db.prepare('SELECT COUNT(*) n FROM chunks').get() as { n: number };
    expect(chunks.n).toBeGreaterThan(5);
    // FTS kept in sync by a trigger.
    const fts = db.prepare('SELECT COUNT(*) n FROM chunks_fts').get() as { n: number };
    expect(fts.n).toBe(chunks.n);
  });

  it('a second pass with no change reindexes nothing', () => {
    reconcileVault(ctx);
    const r2 = reconcileVault(ctx);
    expect(r2.indexed).toBe(0);
    expect(r2.unchanged).toBe(r2.scanned);
  });

  it('every chunk carries a density tier: curated files, distilled sections, verbatim speech', () => {
    // A meeting with both layers in one file: the tier is a property of the
    // SECTION, so Summary and Transcript of the same note must differ.
    fs.mkdirSync(path.join(vault.root, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(vault.root, 'Meetings', '2026-07-29 Tier Probe.md'), [
      '---', 'date: 2026-07-29', 'type: meeting', '---',
      '## Summary', '', 'The team agreed to freeze the schema until the rollout lands.', '',
      '## Transcript', '', '### 00:01:00', '', '**Bob:** so um yeah I think we freeze the schema right',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(vault.root, 'sessions', '2026-07-29-abc.md'), '# Session abc\n\nuser said a thing\n', 'utf8');
    reconcileVault(ctx);

    const tierOfChunk = (like: string): string[] => (db.prepare(
      `SELECT DISTINCT c.tier FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.path LIKE ?
       AND (c.heading_path LIKE ? OR ? = '%')`,
    ).all(like, like === '%Tier Probe%' ? 'Transcript%' : '%', like === '%Tier Probe%' ? 'x' : '%') as Array<{ tier: string }>).map((r) => r.tier);

    // Curated file: every chunk 'curated'.
    expect(tierOfChunk('USER.md')).toEqual(['curated']);
    // Session copy: verbatim, every chunk 'raw'.
    expect(tierOfChunk('sessions/%')).toEqual(['raw']);
    // The meeting's Transcript section is 'raw'...
    expect(tierOfChunk('%Tier Probe%')).toEqual(['raw']);
    // Older synced notes carry bold Gemini-style transcript headings.
    fs.writeFileSync(path.join(vault.root, 'Meetings', '2026-07-01 Old Style.md'), [
      '## **Old Style - Transcript**', '', '### 00:02:00', '', '**Ann:** verbatim words here',
    ].join('\n'), 'utf8');
    reconcileVault(ctx);
    const oldStyle = db.prepare(
      `SELECT DISTINCT c.tier FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.path LIKE '%Old Style%'`,
    ).all() as Array<{ tier: string }>;
    expect(oldStyle.map((r) => r.tier)).toEqual(['raw']);

    // ...and its Summary section is 'processed'.
    const summary = db.prepare(
      `SELECT DISTINCT c.tier FROM chunks c JOIN files f ON f.id = c.file_id
       WHERE f.path LIKE '%Tier Probe%' AND (c.heading_path IS NULL OR c.heading_path NOT LIKE 'Transcript%')`,
    ).all() as Array<{ tier: string }>;
    expect(summary.map((r) => r.tier)).toEqual(['processed']);
  });

  it('a scanner version bump re-indexes untouched files on the next reconcile', () => {
    reconcileVault(ctx);
    // Simulate an index written by an older scanner: the files did not move,
    // only the version did. The promise "a bump re-indexes" must not depend on
    // the file also changing on disk.
    db.prepare('UPDATE files SET scanner_version = 1').run();
    const r = reconcileVault(ctx);
    expect(r.unchanged).toBe(0);
    expect(r.indexed).toBe(r.scanned);
  });

  it('a forced reconcile rebuilds identifiers after a vocabulary change', () => {
    reconcileVault(ctx);
    const stale = () => (db.prepare(
      "SELECT COUNT(*) n FROM chunks WHERE identifiers LIKE '%TENANT ISOLATION%'",
    ).get() as { n: number }).n;
    expect(stale()).toBe(0);

    // The registry gains a term the files already mention. A plain reconcile
    // cannot see it: content hashes did not move, so identifiers stay stale.
    ctx.vocab = new Set([...ctx.vocab, 'TENANT ISOLATION']);
    const plain = reconcileVault(ctx);
    expect(plain.indexed).toBe(0);
    expect(stale()).toBe(0);

    const forced = reconcileVault(ctx, { force: true });
    expect(forced.indexed).toBe(forced.scanned);
    expect(stale()).toBeGreaterThan(0);
  });

  it('rewriting the same content with another EOL keeps the hash (unchanged)', () => {
    reconcileVault(ctx);
    // Rewrites USER.md with the opposite EOL: bytes change, canonical content does not.
    const raw = SYNTHETIC_VAULT['USER.md']!;
    const flipped = eol === 'lf' ? raw.replace(/\n/g, '\r\n') : raw;
    fs.writeFileSync(path.join(vault.root, 'USER.md'), flipped, 'utf8');
    expect(indexFile(ctx, 'USER.md')).toBe('unchanged');
  });

  it('a deleted file leaves the index; a renamed one swaps the path', () => {
    reconcileVault(ctx);
    fs.rmSync(path.join(vault.root, 'daily', '2026-07-15.md'));
    fs.renameSync(
      path.join(vault.root, 'People', 'Bob.md'),
      path.join(vault.root, 'People', 'Bob Tech Lead.md'),
    );
    const r = reconcileVault(ctx);
    expect(r.removed).toBe(2); // the daily and the old path from the rename
    expect(r.indexed).toBe(1); // the new path
    const paths = (db.prepare("SELECT path FROM files WHERE is_deleted = 0").all() as Array<{ path: string }>).map((p) => p.path);
    expect(paths).toContain('People/Bob Tech Lead.md');
    expect(paths).not.toContain('People/Bob.md');
    expect(paths).not.toContain('daily/2026-07-15.md');
  });

  it('a UTF-16 file is refused and logged, never indexed', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('utf16 note', 'utf16le')]);
    fs.writeFileSync(path.join(vault.root, 'utf16.md'), utf16);
    const r = reconcileVault(ctx);
    expect(r.skipped).toContain('utf16.md');
    const row = db.prepare("SELECT COUNT(*) n FROM files WHERE path = 'utf16.md'").get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('classification reaches the database: meeting raw/untrusted, USER curated/evergreen', () => {
    reconcileVault(ctx);
    const meeting = db.prepare("SELECT layer, doc_type, trust, doc_date FROM files WHERE path LIKE 'Meetings/2026%'").get() as Record<string, unknown>;
    expect(meeting).toMatchObject({ layer: 'raw', doc_type: 'meeting', trust: 'untrusted', doc_date: '2026-07-10' });
    const user = db.prepare("SELECT layer, trust, is_evergreen FROM files WHERE path = 'USER.md'").get() as Record<string, unknown>;
    expect(user).toMatchObject({ layer: 'curated', trust: 'curated', is_evergreen: 1 });
  });

  it('a secret in a vault-authored file is masked at index time and never reaches a snippet', async () => {
    const SECRET = 'sk-ant-api03-ZZTESTSECRET1234567890';
    // Authored directly in the vault, not through the write pipeline (finding #4).
    vault.writeFile('leak.md', `# Leak\n\nThe xylophonedeploy runbook stores key ${SECRET} for prod.\n`);
    expect(indexFile(ctx, 'leak.md')).toBe('indexed');

    // The raw secret is in no stored chunk field; the value is masked instead.
    const bodies = db.prepare(
      "SELECT c.body FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.path = 'leak.md'",
    ).all() as Array<{ body: string }>;
    expect(bodies.some((r) => r.body.includes(SECRET))).toBe(false);
    expect(bodies.some((r) => r.body.includes('[REDACTED:secret.anthropic]'))).toBe(true);

    // The redaction is logged for audit.
    const logged = db.prepare("SELECT COUNT(*) n FROM index_log WHERE action = 'redact_secret' AND path = 'leak.md'").get() as { n: number };
    expect(logged.n).toBe(1);

    // A search that surfaces the chunk returns the masked value, never the secret.
    const res = await memorySearch({ db, vocab: ctx.vocab }, { query: 'xylophonedeploy' });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits.every((h) => !h.snippet.includes(SECRET))).toBe(true);
    expect(res.hits.some((h) => h.snippet.includes('[REDACTED:secret.anthropic]'))).toBe(true);

    // The secret is not even searchable: the FTS body holds the masked text.
    const bySecret = await memorySearch({ db, vocab: ctx.vocab }, { query: SECRET });
    expect(bySecret.hits.every((h) => !h.snippet.includes(SECRET))).toBe(true);
  });

  it('reopening the existing database does not reapply the schema (stable user_version)', () => {
    reconcileVault(ctx);
    const before = db.pragma('user_version', { simple: true });
    db.close();
    db = openIndexDb({ rootDir: index.root });
    // Stable across a reopen, and still the current schema version (2 since the
    // review queue's `pending` table was dropped in migration 002).
    expect(db.pragma('user_version', { simple: true })).toBe(before);
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    const n = (db.prepare('SELECT COUNT(*) n FROM files').get() as { n: number }).n;
    expect(n).toBeGreaterThan(0);
  });
});

/**
 * The review queue was removed on 2026-07-28. Dropping the table from the DDL is
 * only half the job: an index created before that date already HAS the table and
 * its rows. Migration 002 has to remove it, or "a discarded item is kept nowhere"
 * would be false on exactly the machines that have been running the longest.
 */
describe('migration 002 (drop the review queue table)', () => {
  let index: ReturnType<typeof makeTmpIndexDir>;

  beforeEach(() => {
    index = makeTmpIndexDir();
  });

  afterEach(() => {
    index.cleanup();
  });

  it('drops an existing pending table and its rows when an old index is opened', () => {
    // Build a v1-shaped database by hand: the current schema plus the table the
    // old DDL created, with user_version left at 1.
    const first = openIndexDb({ rootDir: index.root });
    first.exec(`
      CREATE TABLE pending (
        id TEXT PRIMARY KEY, text TEXT NOT NULL, class TEXT NOT NULL,
        target_path TEXT NOT NULL, target_section TEXT, source_kind TEXT NOT NULL,
        origin TEXT NOT NULL, confidence REAL NOT NULL, state TEXT NOT NULL,
        proposed_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT,
        edited INTEGER NOT NULL DEFAULT 0, session_id TEXT, turn_id TEXT, evidence TEXT
      );
      CREATE INDEX ix_pending_open ON pending(state, proposed_at);
      INSERT INTO pending (id, text, class, target_path, source_kind, origin, confidence, state, proposed_at)
      VALUES ('01OLD', 'a candidate that was waiting for review', 'style_preference', 'user', 'capture', 'session_extract', 0.5, 'open', '2026-07-01T00:00:00Z');
    `);
    // A v1 database also predates the tier column (migration 003), and the
    // current schema.sql already carries it; drop it so the replay is honest
    // and exercises 003 as well.
    first.exec('ALTER TABLE chunks DROP COLUMN tier;');
    first.pragma('user_version = 1');
    expect(first.prepare('SELECT COUNT(*) n FROM pending').get()).toEqual({ n: 1 });
    first.close();

    // Reopening runs the migration.
    const db = openIndexDb({ rootDir: index.root });
    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE name = 'pending'").get();
      expect(table).toBeUndefined();
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE name = 'ix_pending_open'").get();
      expect(idx).toBeUndefined();
      // 002 dropped the queue AND 003 re-added the tier column on the way up.
      expect(db.pragma('user_version', { simple: true })).toBe(3);
      const tierCol = db.prepare("SELECT COUNT(*) n FROM pragma_table_info('chunks') WHERE name = 'tier'").get() as { n: number };
      expect(tierCol.n).toBe(1);
    } finally {
      db.close();
    }
  });
});
