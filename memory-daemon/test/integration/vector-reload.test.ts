import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openIndexDb } from '../../src/index/db.js';
import { reconcileVault } from '../../src/index/reconcile.js';
import { loadRegistryVocab } from '../../src/core/identifiers.js';
import { BruteForceVectorIndex } from '../../src/index/search/vector.js';
import { makeTmpVault, makeTmpIndexDir, type TmpVault } from '../helpers/tmp-vault.js';
import { CLIENT_A_FILES } from '../fixtures/multi-vault.js';

/**
 * BruteForceVectorIndex.reload() streams rows into a preallocated matrix. These
 * tests use a real index db with real chunks, and check the arrays through what
 * search() returns, because the row arrays are private.
 */

const MODEL = 'test-model';
const DIM = 4;
const unit = (i: number): Float32Array => {
  const v = new Float32Array(DIM);
  v[i % DIM] = 1;
  return v;
};

describe('vector index reload', () => {
  let vault: TmpVault;
  let index: ReturnType<typeof makeTmpIndexDir>;
  let db: Database.Database;
  let chunkIds: number[];

  /** Stores a vector for the chunk, replacing any earlier one for the same model. */
  const embed = (chunkId: number, vec: Float32Array): void => {
    const hash = (db.prepare('SELECT chunk_hash AS h FROM chunks WHERE id = ?').get(chunkId) as { h: string }).h;
    db.prepare('INSERT OR REPLACE INTO embeddings (chunk_hash, model, dim, vec, embedded_at) VALUES (?, ?, ?, ?, ?)')
      .run(hash, MODEL, vec.length, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), Date.now());
  };

  beforeEach(() => {
    vault = makeTmpVault(CLIENT_A_FILES, { eol: 'lf' });
    index = makeTmpIndexDir();
    db = openIndexDb({ rootDir: index.root });
    reconcileVault({ db, vaultName: 'clientA', vaultRoot: vault.root, vocab: loadRegistryVocab(vault.root) });
    chunkIds = (db.prepare('SELECT id FROM chunks ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id);
  });

  afterEach(() => {
    db.close();
    index.cleanup();
    vault.cleanup();
  });

  it('skips rows whose vector has the wrong dimension and keeps the other rows aligned with their chunk ids', () => {
    expect(chunkIds.length).toBeGreaterThanOrEqual(4);
    const [a, b, c, d] = chunkIds as [number, number, number, number];
    embed(a, unit(0));
    embed(b, new Float32Array([1, 0, 0, 0, 0, 0])); // another model's dimension
    embed(c, unit(1));
    embed(d, unit(2));

    const vindex = new BruteForceVectorIndex(db, MODEL, DIM);
    vindex.reload();
    expect(vindex.size).toBe(3);

    // Each query is one axis, so the one chunk stored on that axis must come back alone.
    expect(vindex.search(unit(0), 10, 0.5).map((h) => h.chunkId)).toEqual([a]);
    expect(vindex.search(unit(1), 10, 0.5).map((h) => h.chunkId)).toEqual([c]);
    expect(vindex.search(unit(2), 10, 0.5).map((h) => h.chunkId)).toEqual([d]);
  });

  it('a second reload after embeddings are removed gives the smaller size', () => {
    for (const id of chunkIds) embed(id, unit(id));
    const vindex = new BruteForceVectorIndex(db, MODEL, DIM);
    vindex.reload();
    expect(vindex.size).toBe(chunkIds.length);

    const gone = chunkIds[0]!;
    db.prepare('DELETE FROM embeddings WHERE chunk_hash = (SELECT chunk_hash FROM chunks WHERE id = ?)').run(gone);
    vindex.reload();
    expect(vindex.size).toBeLessThan(chunkIds.length);
    expect(vindex.search(unit(gone), 100, 0.5).map((h) => h.chunkId)).not.toContain(gone);
  });

  it('a second reload after the file is deleted drops its chunks from the index', () => {
    for (const id of chunkIds) embed(id, unit(id));
    const vindex = new BruteForceVectorIndex(db, MODEL, DIM);
    vindex.reload();
    expect(vindex.size).toBe(chunkIds.length);

    db.prepare('UPDATE files SET is_deleted = 1').run();
    vindex.reload();
    expect(vindex.size).toBe(0);
    expect(vindex.search(unit(0), 100, 0)).toEqual([]);
  });

  it('two chunks with the same chunk_hash (same text and file name in two vaults) both stay in the index, although they share one embedding row', () => {
    const twin = '# Twin\n\n- identical twin note about the quarterly ledger close.\n';
    // The hash covers the file name and the text, so the twin must have the same
    // relative path in another vault.
    vault.writeFile('twin.md', twin);
    const other = makeTmpVault({ 'twin.md': twin }, { eol: 'lf' });
    try {
      reconcileVault({ db, vaultName: 'clientA', vaultRoot: vault.root, vocab: loadRegistryVocab(vault.root) });
      reconcileVault({ db, vaultName: 'clientB', vaultRoot: other.root, vocab: loadRegistryVocab(other.root) });
    } finally {
      other.cleanup();
    }
    const dupes = db.prepare(`
      SELECT chunk_hash FROM chunks GROUP BY chunk_hash HAVING COUNT(*) > 1
    `).all() as Array<{ chunk_hash: string }>;
    expect(dupes.length).toBeGreaterThan(0); // the fixture really produced a shared hash

    const all = (db.prepare('SELECT id FROM chunks ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id);
    const shared = (db.prepare(
      'SELECT id FROM chunks WHERE chunk_hash = ? ORDER BY id',
    ).all(dupes[0]!.chunk_hash) as Array<{ id: number }>).map((r) => r.id);
    expect(shared.length).toBeGreaterThanOrEqual(2);
    for (const id of all) embed(id, unit(0)); // one embeddings row per distinct hash

    const embeddingRows = (db.prepare('SELECT COUNT(*) AS n FROM embeddings').get() as { n: number }).n;
    expect(embeddingRows).toBeLessThan(all.length);

    const vindex = new BruteForceVectorIndex(db, MODEL, DIM);
    vindex.reload();
    expect(vindex.size).toBe(all.length);
    const found = vindex.search(unit(0), 1000, 0.5).map((h) => h.chunkId);
    for (const id of shared) expect(found).toContain(id);
  });

  it('the layer and doc_type scope filters still return only matching rows after a reload', () => {
    // Pin each chunk's file to a known layer and doc type, whatever the fixture holds.
    const files = db.prepare('SELECT DISTINCT file_id FROM chunks ORDER BY file_id').all() as Array<{ file_id: number }>;
    expect(files.length).toBeGreaterThanOrEqual(3);
    const setMeta = db.prepare('UPDATE files SET layer = ?, doc_type = ? WHERE id = ?');
    setMeta.run('curated', 'curated', files[0]!.file_id);
    setMeta.run('reservoir', 'meeting', files[1]!.file_id);
    setMeta.run('reservoir', 'daily', files[2]!.file_id);
    for (const f of files.slice(3)) setMeta.run('reservoir', 'topic', f.file_id);

    for (const id of chunkIds) embed(id, unit(0)); // same vector: only the scope can decide
    const vindex = new BruteForceVectorIndex(db, MODEL, DIM);
    vindex.reload();

    const ids = (scope: 'all' | 'curated' | 'reservoir' | 'meetings' | 'daily'): number[] =>
      vindex.search(unit(0), 1000, 0.5, undefined, scope).map((h) => h.chunkId).sort((x, y) => x - y);
    const expected = (where: string): number[] => (db.prepare(
      `SELECT c.id FROM chunks c JOIN files f ON f.id = c.file_id WHERE ${where} ORDER BY c.id`,
    ).all() as Array<{ id: number }>).map((r) => r.id);

    expect(ids('all')).toEqual(chunkIds);
    expect(ids('curated')).toEqual(expected("f.layer = 'curated'"));
    expect(ids('reservoir')).toEqual(expected("f.layer = 'reservoir'"));
    expect(ids('meetings')).toEqual(expected("f.doc_type = 'meeting'"));
    expect(ids('daily')).toEqual(expected("f.doc_type = 'daily'"));
    for (const scope of ['curated', 'meetings', 'daily'] as const) expect(ids(scope).length).toBeGreaterThan(0);
    expect(ids('curated').length).toBeLessThan(chunkIds.length);
  });
});
