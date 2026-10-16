import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openIndexDb } from '../../src/index/db.js';
import { reconcileVault } from '../../src/index/reconcile.js';
import { loadRegistryVocab } from '../../src/core/identifiers.js';
import { readableVaults } from '../../src/core/vault-scope.js';
import { buildSearchContext } from '../../src/index/context.js';
import { memorySearch, type SearchContext, type SearchHit, type VectorChannel } from '../../src/index/search/search.js';
import { BruteForceVectorIndex } from '../../src/index/search/vector.js';
import { buildRetrievalPush } from '../../src/daemon/capture/push.js';
import type { MemoryConfig } from '../../src/core/config.js';
import { makeTmpVault, makeTmpIndexDir, type TmpVault } from '../helpers/tmp-vault.js';
import { CLIENT_A_FILES, CLIENT_B_FILES, GLOBAL_VAULT_FILES, SHARED_QUERY } from '../fixtures/multi-vault.js';

/**
 * Vault READ isolation: a caller sees its OWN vault and nothing else. The shared
 * 'global' vault joins only when the caller's repo opted in (`share_global:
 * true`). This is a confidentiality boundary, so each query path is checked
 * separately (ranked lexical, identifier bypass, substring fallback, recency
 * browse, a saved cursor, the vocabulary that expands a query) and each check
 * also proves the leak WOULD happen without the scope, by running the same query
 * with the human's cross-vault view.
 */

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

/** Every path_hint of a result, as "<vault>:<path>". */
const hints = (hits: SearchHit[]): string[] => hits.map((h) => h.path_hint);

describe('vault read isolation', () => {
  let globalVault: TmpVault;
  let clientA: TmpVault;
  let clientB: TmpVault;
  let index: ReturnType<typeof makeTmpIndexDir>;
  let db: Database.Database;
  let config: MemoryConfig;
  let ctxA: SearchContext;        // an agent in clientA's repo, no sharing
  let ctxAShared: SearchContext;  // the same repo with share_global: true
  let ctxNothing: SearchContext;  // a repo whose marker could not be honoured
  let ctxGlobalOnly: SearchContext;
  let ctxAll: SearchContext;      // the human's `--vault all`

  beforeEach(() => {
    globalVault = makeTmpVault(GLOBAL_VAULT_FILES, { eol: 'lf' });
    clientA = makeTmpVault(CLIENT_A_FILES, { eol: 'lf' });
    clientB = makeTmpVault(CLIENT_B_FILES, { eol: 'lf' });
    index = makeTmpIndexDir();
    db = openIndexDb({ rootDir: index.root });
    config = {
      vaults: { global: globalVault.root, clientA: clientA.root, clientB: clientB.root },
      defaultVault: 'global',
      embeddings: { enabled: false, model: 'x' },
    };
    for (const [name, root] of Object.entries(config.vaults)) {
      reconcileVault({ db, vaultName: name, vaultRoot: root, vocab: loadRegistryVocab(root) });
    }
    ctxA = buildSearchContext(db, config, undefined, readableVaults(config, 'clientA'));
    ctxAShared = buildSearchContext(db, config, undefined, readableVaults(config, 'clientA', true));
    ctxNothing = buildSearchContext(db, config, undefined, readableVaults(config, null));
    ctxGlobalOnly = buildSearchContext(db, config, undefined, readableVaults(config, 'global'));
    ctxAll = buildSearchContext(db, config, undefined, readableVaults(config, 'all'));
  });

  afterEach(() => {
    db.close();
    index.cleanup();
    globalVault.cleanup();
    clientA.cleanup();
    clientB.cleanup();
  });

  it('the ranked search returns the caller vault ALONE: no other client, and no shared vault', async () => {
    const res = await memorySearch(ctxA, { query: SHARED_QUERY, k: 10 });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(hints(res.hits).every((h) => h.startsWith('clientA:'))).toBe(true);
    for (const hit of res.hits) expect(hit.snippet).not.toContain('BETA_');
    // The shared vault is NOT in by default: it needs an invitation.
    expect(hints(res.hits).some((h) => h.startsWith('global:'))).toBe(false);
    for (const hit of res.hits) expect(hit.snippet).not.toContain('GLOBAL_MARKER');
  });

  it('share_global: true adds the shared vault, and still never the other client', async () => {
    // The opt-in half of the rule. Same query, same repo, one line in the marker.
    const res = await memorySearch(ctxAShared, { query: SHARED_QUERY, k: 10 });
    expect(hints(res.hits).some((h) => h.startsWith('clientA:'))).toBe(true);
    expect(hints(res.hits).some((h) => h.startsWith('global:'))).toBe(true);
    expect(hints(res.hits).some((h) => h.startsWith('clientB:'))).toBe(false);
  });

  it('a caller with no readable vault gets nothing at all, from any channel', async () => {
    // The broken-marker state. An empty readable set must hide everything, and
    // must never be read as "no filter".
    for (const req of [
      { query: SHARED_QUERY, k: 10 },
      { query: 'AAA-111' },
      { query: 'etaxylophone' },
      { query: 'xx', mode: 'browse' as const, k: 20 },
    ]) {
      expect((await memorySearch(ctxNothing, req)).hits).toEqual([]);
    }
  });

  it('the same query without the scope does return the other client (the leak is real)', async () => {
    const res = await memorySearch(ctxAll, { query: SHARED_QUERY, k: 10 });
    expect(hints(res.hits).some((h) => h.startsWith('clientB:'))).toBe(true);
  });

  it('a global-only caller sees neither client vault', async () => {
    const res = await memorySearch(ctxGlobalOnly, { query: SHARED_QUERY, k: 10 });
    expect(res.hits.length).toBeGreaterThan(0);
    for (const hint of hints(res.hits)) expect(hint.startsWith('global:')).toBe(true);
  });

  it('the identifier bypass is scoped: another client ticket key returns nothing', async () => {
    const leak = await memorySearch(ctxA, { query: 'BBB-222' });
    expect(leak.hits).toEqual([]);
    expect(leak.empty_reason).toBeDefined();
    // The bypass still works for the caller's OWN ticket key.
    const own = await memorySearch(ctxA, { query: 'AAA-111' });
    expect(own.hits.length).toBeGreaterThan(0);
    expect(own.hits[0]!.channels).toContain('exact');
    // And the key really is findable when the view is not scoped.
    const wide = await memorySearch(ctxAll, { query: 'BBB-222' });
    expect(wide.hits.length).toBeGreaterThan(0);
    expect(hints(wide.hits).every((h) => h.startsWith('clientB:'))).toBe(true);
  });

  it('the substring fallback is scoped: a word only the other client has returns nothing', async () => {
    const leak = await memorySearch(ctxA, { query: 'etaxylophone' });
    expect(leak.hits).toEqual([]);
    // Unscoped, the very same fragment resolves through the substring channel.
    const wide = await memorySearch(ctxAll, { query: 'etaxylophone' });
    expect(wide.hits.length).toBeGreaterThan(0);
    expect(wide.hits[0]!.channels).toContain('substring');
    expect(hints(wide.hits).every((h) => h.startsWith('clientB:'))).toBe(true);
  });

  it('browse (recency listing) is scoped, even though the other client has the newest note', async () => {
    // Proof the ordering favors clientB: unscoped, its 2030 note is listed first.
    const wide = await memorySearch(ctxAll, { query: 'xx', mode: 'browse', k: 3 });
    expect(wide.hits[0]!.path_hint.startsWith('clientB:')).toBe(true);

    const res = await memorySearch(ctxA, { query: 'xx', mode: 'browse', k: 20 });
    expect(res.hits.length).toBeGreaterThan(0);
    for (const hint of hints(res.hits)) expect(hint.startsWith('clientB:')).toBe(false);
  });

  it('a cursor made with a wide view pages back scoped to the caller asking for it', async () => {
    // Cursors live in one shared table keyed by a random id, so a page must be
    // re-scoped to whoever asks for it, not to whoever created it.
    const page1 = await memorySearch(ctxAll, { query: SHARED_QUERY, k: 2, mode: 'scroll' });
    expect(page1.cursor).toBeDefined();
    const page2 = await memorySearch(ctxA, { query: SHARED_QUERY, cursor: page1.cursor! });
    for (const hint of hints(page2.hits)) expect(hint.startsWith('clientB:')).toBe(false);
  });

  it('query vocabulary comes only from readable vaults', async () => {
    // _registry.md terms feed identifier extraction and the exact bypass, so an
    // unscoped vocabulary would let another client's names steer this query.
    expect(ctxA.vocab.has('ALPHACORP LEDGER')).toBe(true);
    expect(ctxA.vocab.has('BETACORP LEDGER')).toBe(false);
    expect(ctxGlobalOnly.vocab.has('ALPHACORP LEDGER')).toBe(false);
    // A caller with no readable vault loads no vocabulary at all.
    expect(ctxNothing.vocab.size).toBe(0);
    // The human's cross-vault view still loads everything.
    expect(ctxAll.vocab.has('ALPHACORP LEDGER')).toBe(true);
    expect(ctxAll.vocab.has('BETACORP LEDGER')).toBe(true);
  });

  it('the vector channel is told the readable set, and cannot leak even if it ignores it', async () => {
    const otherIds = (db.prepare(
      'SELECT c.id FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.vault = ?',
    ).all('clientB') as Array<{ id: number }>).map((r) => r.id);
    expect(otherIds.length).toBeGreaterThan(0);

    let told: readonly string[] | undefined | 'never called' = 'never called';
    const rogue: VectorChannel = {
      warm: () => true,
      // Answers with the other client's chunks at a near-perfect cosine, and
      // ignores the readable set it is given: the worst case for the vector path.
      search: async (_q, _pool, _min, vaults) => {
        told = vaults;
        return otherIds.map((id) => ({ chunkId: id, cosine: 0.99 }));
      },
    };
    const res = await memorySearch({ ...ctxA, vector: rogue }, { query: SHARED_QUERY, k: 10 });
    // The channel receives the set, so the real index can scope its own scan...
    expect(told).toEqual(['clientA']);
    // ...and a channel that ignores it still cannot put another vault in front
    // of the caller: hydrate drops every chunk outside the readable vaults.
    for (const hint of hints(res.hits)) expect(hint.startsWith('clientB:')).toBe(false);
    for (const hit of res.hits) expect(hit.snippet).not.toContain('BETA_');
  });

  it('the real vector index scopes its own scan to the readable vaults', () => {
    // Give every chunk the SAME unit vector, so ranking cannot explain anything:
    // only the vault filter decides what comes back.
    const dim = 4;
    const vec = new Float32Array([1, 0, 0, 0]);
    const blob = Buffer.from(vec.buffer);
    const rows = db.prepare('SELECT DISTINCT chunk_hash FROM chunks').all() as Array<{ chunk_hash: string }>;
    const insert = db.prepare('INSERT OR REPLACE INTO embeddings (chunk_hash, model, dim, vec, embedded_at) VALUES (?, ?, ?, ?, ?)');
    for (const row of rows) insert.run(row.chunk_hash, 'test-model', dim, blob, Date.now());

    const vaultOf = (id: number): string => (db.prepare(
      'SELECT f.vault AS v FROM chunks c JOIN files f ON f.id = c.file_id WHERE c.id = ?',
    ).get(id) as { v: string }).v;

    const vindex = new BruteForceVectorIndex(db, 'test-model', dim);
    vindex.reload();
    expect(vindex.size).toBeGreaterThan(0);

    const wide = vindex.search(vec, 100, 0.5);
    expect(wide.some((h) => vaultOf(h.chunkId) === 'clientB')).toBe(true);

    const scoped = vindex.search(vec, 100, 0.5, ['clientA', 'global']);
    expect(scoped.length).toBeGreaterThan(0);
    for (const hit of scoped) expect(vaultOf(hit.chunkId)).not.toBe('clientB');
  });

  it('an unknown vault name fails closed: it matches no file and returns nothing', async () => {
    // The name is not expanded to anything else, so a bad name is simply empty.
    const ctxUnknown = buildSearchContext(db, config, undefined, readableVaults(config, 'clientZ'));
    expect((await memorySearch(ctxUnknown, { query: SHARED_QUERY, k: 10 })).hits).toEqual([]);
  });

  describe('SessionStart retrieval push', () => {
    let repo: string;

    beforeEach(() => {
      // The push builds its query from git signals, so it needs a real repo.
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mviso-repo-'));
      git(repo, 'init', '-q');
      git(repo, 'config', 'user.email', 'test@example.com');
      git(repo, 'config', 'user.name', 'Test');
      git(repo, 'config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(repo, 'app.ts'), '// code\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'quarterly billing migration work');
    });

    afterEach(() => {
      fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
    });

    it('injects the session vault only, not the daemon default vault', async () => {
      const forA = await buildRetrievalPush(db, config, repo, undefined, { vault: 'clientA', shareGlobal: false });
      expect(forA).toContain('clientA:');          // the block is not simply empty
      expect(forA).not.toContain('clientB:');
      expect(forA).not.toContain('BETA_');
      // The shared vault is not pushed either, unless the repo asked for it.
      expect(forA).not.toContain('global:');

      // The same repo with the other vault gets the other content, which proves
      // the block follows the session's vault and not config.defaultVault.
      const forB = await buildRetrievalPush(db, config, repo, undefined, { vault: 'clientB', shareGlobal: false });
      expect(forB).toContain('clientB:');
      expect(forB).not.toContain('clientA:');
      expect(forB).not.toContain('ALPHA_');
    });

    it('a session with no readable vault gets no push block at all', async () => {
      const none = await buildRetrievalPush(db, config, repo, undefined, { vault: null, shareGlobal: false });
      expect(none).toBe('');
    });
  });
});
