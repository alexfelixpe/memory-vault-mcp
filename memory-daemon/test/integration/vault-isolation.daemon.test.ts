import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { startDaemon, type DaemonStart } from '../../src/daemon/main.js';
import { DaemonClient } from '../../src/mcp/client.js';
import type { MemoryConfig } from '../../src/core/config.js';
import { makeTmpVault, makeTmpIndexDir, type TmpVault } from '../helpers/tmp-vault.js';
import { CLIENT_A_FILES, CLIENT_B_FILES, GLOBAL_VAULT_FILES, SHARED_QUERY } from '../fixtures/multi-vault.js';

/**
 * The same isolation, but end to end through the real daemon: the readable set
 * is decided on the SERVER from the single vault name the caller resolved, and
 * the frozen SessionStart snapshot follows the session's repo, not the vault the
 * daemon happens to default to.
 */

const silent = pino({ level: 'silent' });

describe('vault read isolation through the daemon', () => {
  let globalVault: TmpVault;
  let clientA: TmpVault;
  let clientB: TmpVault;
  let index: ReturnType<typeof makeTmpIndexDir>;
  let daemon: DaemonStart;
  let client: DaemonClient;
  let config: MemoryConfig;
  let repoA: string;

  beforeEach(async () => {
    globalVault = makeTmpVault(GLOBAL_VAULT_FILES, { eol: 'lf' });
    clientA = makeTmpVault(CLIENT_A_FILES, { eol: 'lf' });
    clientB = makeTmpVault(CLIENT_B_FILES, { eol: 'lf' });
    index = makeTmpIndexDir();
    config = {
      vaults: { global: globalVault.root, clientA: clientA.root, clientB: clientB.root },
      // The daemon's own default is deliberately NOT clientA: a session in
      // clientA's repo must not depend on which repo started the daemon.
      defaultVault: 'clientB',
      embeddings: { enabled: false, model: 'x' },
    };
    const pipePath = process.platform === 'win32'
      ? `\\\\.\\pipe\\memory-vault.iso.${crypto.randomBytes(6).toString('hex')}`
      : path.join(os.tmpdir(), `mv-iso-${crypto.randomBytes(6).toString('hex')}.sock`);
    daemon = await startDaemon({
      pipePath, indexRootDir: index.root, watch: false, embedder: null,
      reconcileIntervalMs: 3_600_000, log: silent, config,
    });
    client = new DaemonClient({ pipePath, spawnCommand: false });
    // Index synchronously: the boot reconcile is asynchronous, so the searches
    // below would otherwise race it.
    await client.request('reindex');

    // A repo that declares it belongs to clientA, like a real client checkout.
    repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'mviso-repoA-'));
    fs.writeFileSync(path.join(repoA, '.memory.yml'), 'vault: clientA\n', 'utf8');
  });

  afterEach(async () => {
    client.close();
    if (!daemon.alreadyRunning) await daemon.close();
    index.cleanup();
    globalVault.cleanup();
    clientA.cleanup();
    clientB.cleanup();
    fs.rmSync(repoA, { recursive: true, force: true, maxRetries: 5 });
  });

  it('a search resolved to clientA never returns clientB, whatever the daemon default is', async () => {
    const res = await client.request('search', { query: SHARED_QUERY, k: 10, vault: 'clientA' });
    expect(res.hits.length).toBeGreaterThan(0);
    for (const hit of res.hits) expect(hit.path_hint.startsWith('clientB:')).toBe(false);
    expect(res.hits.some((h) => h.path_hint.startsWith('clientA:'))).toBe(true);
  });

  it('the human "all" view does cross vaults (the escape hatch works)', async () => {
    const res = await client.request('search', { query: SHARED_QUERY, k: 10, vault: 'all' });
    const vaults = new Set(res.hits.map((h) => h.path_hint.split(':')[0]));
    expect(vaults.has('clientA')).toBe(true);
    expect(vaults.has('clientB')).toBe(true);
  });

  it('a request with no vault falls back to the daemon default vault alone', async () => {
    const res = await client.request('search', { query: SHARED_QUERY, k: 10 });
    expect(res.hits.length).toBeGreaterThan(0);
    for (const hit of res.hits) expect(hit.path_hint.split(':')[0]).toBe('clientB');
  });

  it('a request that names a vault and asks for sharing gets both, and only both', async () => {
    // The daemon takes the opt-in from the request, next to the vault name. Its
    // own config cannot supply it: the daemon is shared.
    const res = await client.request('search', { query: SHARED_QUERY, k: 10, vault: 'clientA', share_global: true });
    const vaults = new Set(res.hits.map((h) => h.path_hint.split(':')[0]));
    expect(vaults.has('clientA')).toBe(true);
    expect(vaults.has('global')).toBe(true);
    expect(vaults.has('clientB')).toBe(false);
  });

  it('a request that carries a null vault reads nothing at all', async () => {
    // What the proxy sends from a repo whose marker could not be honoured.
    const res = await client.request('search', { query: SHARED_QUERY, k: 10, vault: null });
    expect(res.hits).toEqual([]);
  });

  it('the frozen snapshot follows the session repo, not the daemon default vault', async () => {
    const snap = await client.request('snapshot', { session_id: 'iso-session-1', cwd: repoA });
    // PROJECT.md comes from the vault the repo's .memory.yml names.
    expect(snap.body).toContain('ALPHA_PROJECT_MARKER');
    expect(snap.body).not.toContain('BETA_PROJECT_MARKER');
    // The shared personal layer is NOT there: this repo did not ask for it.
    expect(snap.body).not.toContain('GLOBAL_MARKER');
    // Frozen: the same session id returns the same bytes.
    const again = await client.request('snapshot', { session_id: 'iso-session-1', cwd: repoA });
    expect(again.frozen).toBe(true);
    expect(again.sha256).toBe(snap.sha256);
  });

  it('the snapshot includes the shared vault when the repo opted in with share_global', async () => {
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'mviso-shared-'));
    fs.writeFileSync(path.join(shared, '.memory.yml'), 'vault: clientA\nshare_global: true\n', 'utf8');
    try {
      const snap = await client.request('snapshot', { session_id: 'iso-session-shared', cwd: shared });
      expect(snap.body).toContain('ALPHA_PROJECT_MARKER');
      expect(snap.body).toContain('GLOBAL_MARKER');
      expect(snap.body).not.toContain('BETA_PROJECT_MARKER');
    } finally {
      fs.rmSync(shared, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('a marker naming an unknown vault gives an EMPTY snapshot', async () => {
    // The dangerous case: a typo in .memory.yml. The daemon must not fall back
    // to its own default vault, which here is the OTHER client, and it must not
    // fall back to the shared vault either: that one needs an invitation.
    const typo = fs.mkdtempSync(path.join(os.tmpdir(), 'mviso-typo-'));
    fs.writeFileSync(path.join(typo, '.memory.yml'), 'vault: clientTYPO\n', 'utf8');
    try {
      const snap = await client.request('snapshot', { session_id: 'iso-session-typo', cwd: typo });
      expect(snap.body).toBe('');
    } finally {
      fs.rmSync(typo, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('a malformed marker gives an empty snapshot too', async () => {
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'mviso-broken-'));
    fs.writeFileSync(path.join(broken, '.memory.yml'), 'vault: [unclosed\n', 'utf8');
    try {
      const snap = await client.request('snapshot', { session_id: 'iso-session-broken', cwd: broken });
      expect(snap.body).toBe('');
    } finally {
      fs.rmSync(broken, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('a session in a repo with no marker uses the daemon default vault', async () => {
    // No .memory.yml: there is no vault of its own, so the config default is the
    // honest answer (it is the same vault its writes already go to).
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'mviso-plain-'));
    try {
      const snap = await client.request('snapshot', { session_id: 'iso-session-2', cwd: plain });
      expect(snap.body).toContain('BETA_PROJECT_MARKER');
      expect(snap.body).not.toContain('ALPHA_PROJECT_MARKER');
    } finally {
      fs.rmSync(plain, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
