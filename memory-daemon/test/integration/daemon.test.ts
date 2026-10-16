import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { startDaemon, type DaemonStart } from '../../src/daemon/main.js';
import { DaemonClient, DaemonUnavailableError, RpcError } from '../../src/mcp/client.js';
import { makeTmpVault, makeTmpIndexDir, type TmpVault } from '../helpers/tmp-vault.js';
import { SYNTHETIC_VAULT } from '../fixtures/synthetic-vault.js';
import type { MemoryConfig } from '../../src/core/config.js';

/**
 * Daemon in its own test process: one pipe per test, temporary vault and index,
 * accelerated reconcile. The watcher is tested with short polling
 * (awaitWriteFinish holds ~400ms by design).
 */

const silent = pino({ level: 'silent' });

function testPipe(): string {
  const id = crypto.randomBytes(6).toString('hex');
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\memory-vault.test.${id}`
    : path.join(os.tmpdir(), `memory-vault.test.${id}.sock`);
}

async function poll<T>(fn: () => Promise<T | undefined>, timeoutMs = 8000, stepMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`poll timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe('daemon (Increment 2)', () => {
  let vault: TmpVault;
  let index: ReturnType<typeof makeTmpIndexDir>;
  let pipePath: string;
  let daemon: DaemonStart | undefined;
  let client: DaemonClient;
  let config: MemoryConfig;

  beforeEach(async () => {
    vault = makeTmpVault(SYNTHETIC_VAULT, { eol: 'lf' });
    index = makeTmpIndexDir();
    pipePath = testPipe();
    config = {
      vaults: { global: vault.root },
      defaultVault: 'global',
      embeddings: { enabled: false, model: 'multilingual-e5-small' },
    };
    daemon = await startDaemon({
      pipePath, config, indexRootDir: index.root,
      reconcileIntervalMs: 60_000, log: silent,
    });
    expect(daemon.alreadyRunning).toBe(false);
    client = new DaemonClient({ pipePath, spawnCommand: false });
    // Waits for the initial reconcile to populate the index AND the watcher to
    // finish the initial scan: a write during the scan is swallowed by ignoreInitial.
    await poll(async () => {
      const s = await client.request('status');
      return s.lastReconcileAt !== null && s.watcherReady ? s : undefined;
    });
  });

  afterEach(async () => {
    client.close();
    if (daemon && !daemon.alreadyRunning) await daemon.close();
    index.cleanup();
    vault.cleanup();
  });

  it('ping returns pid, version and protocol', async () => {
    const ping = await client.request('ping');
    expect(ping.pid).toBe(process.pid);
    expect(ping.protocol).toBe(1);
  });

  it('search over the pipe returns the same results as the local search', async () => {
    const res = await client.request('search', { query: 'PROJ-123' });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0]!.channels).toContain('exact');
  });

  it('a second instance on the same pipe reports alreadyRunning and does not open the database', async () => {
    const second = await startDaemon({
      pipePath, config, indexRootDir: index.root, log: silent,
    });
    expect(second.alreadyRunning).toBe(true);
  });

  it('watcher: a new file appears in search within a few seconds', async () => {
    vault.writeFile('Topics/New Topic.md', '# New Topic\n\n- unique quantum xylophone phrase approved.\n');
    const hit = await poll(async () => {
      const res = await client.request('search', { query: 'quantum xylophone' });
      return res.hits.length > 0 ? res.hits[0] : undefined;
    });
    expect(hit.path_hint).toContain('New Topic');
  });

  it('watcher: a rename swaps the old path for the new one', async () => {
    fs.renameSync(
      path.join(vault.root, 'People', 'Bob.md'),
      path.join(vault.root, 'People', 'Bob Renamed.md'),
    );
    await poll(async () => {
      const res = await client.request('search', { query: 'tech lead North Platform' });
      const paths = res.hits.map((h) => h.path_hint).join(' ');
      return paths.includes('Bob Renamed.md') && !paths.includes('People/Bob.md') ? true : undefined;
    });
  });

  it('watcher: a delete disappears from search', async () => {
    fs.rmSync(path.join(vault.root, 'daily', '2026-07-15.md'));
    await poll(async () => {
      const res = await client.request('search', { query: 'review of the schema migration', scope: 'daily' });
      return res.hits.length === 0 ? true : undefined;
    });
  });

  it('a manual reindex over the pipe returns counts per vault', async () => {
    const out = await client.request('reindex', {});
    expect(out['global']).toBeDefined();
    expect(out['global']!.scanned).toBeGreaterThan(0);
  });

  it('a wrong protocol gets PROTOCOL_MISMATCH, invalid JSON gets BAD_JSON', async () => {
    const raw = net.connect({ path: pipePath });
    raw.setEncoding('utf8');
    const lines: string[] = [];
    raw.on('data', (d: string) => lines.push(...d.split('\n').filter((l) => l.trim() !== '')));
    await new Promise<void>((r) => raw.once('connect', () => r()));
    raw.write(JSON.stringify({ v: 99, id: 'x', method: 'ping' }) + '\n');
    raw.write('this is not json\n');
    await poll(async () => (lines.length >= 2 ? true : undefined), 3000, 50);
    raw.destroy();
    const parsed = lines.map((l) => JSON.parse(l) as { ok: boolean; error?: { code: string } });
    expect(parsed.some((p) => p.error?.code === 'PROTOCOL_MISMATCH')).toBe(true);
    expect(parsed.some((p) => p.error?.code === 'BAD_JSON')).toBe(true);
  });

  it('shutdown over the pipe: responds, dies, and a client without spawn sees DAEMON_UNAVAILABLE', async () => {
    const ack = await client.request('shutdown');
    expect(ack.stopping).toBe(true);
    client.close();
    // Shutdown is asynchronous (ack first, pipe dies after): waits for the
    // pipe to refuse the connection before asserting.
    await poll(async () => {
      const probe = new DaemonClient({ pipePath, spawnCommand: false, connectWindowMs: 200 });
      try {
        await probe.request('ping');
        return undefined;
      } catch (e) {
        return e instanceof DaemonUnavailableError ? true : undefined;
      } finally {
        probe.close();
      }
    }, 5000);
    // afterEach calls daemon.close(): same promise, waits for the database to close.
  });

  it('an unknown method becomes an RpcError with a hint', async () => {
    // @ts-expect-error intentional method outside the MethodMap
    await expect(client.request('does_not_exist')).rejects.toSatisfy(
      (e: unknown) => e instanceof RpcError && e.code === 'UNKNOWN_METHOD' && e.hint.length > 0,
    );
  });
});
