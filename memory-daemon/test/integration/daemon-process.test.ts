import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonClient, DaemonUnavailableError } from '../../src/mcp/client.js';
import { makeTmpVault, makeTmpIndexDir, type TmpVault } from '../helpers/tmp-vault.js';
import { SYNTHETIC_VAULT } from '../fixtures/synthetic-vault.js';

/**
 * Real PROCESS behavior: single instance via the pipe (the second exits with
 * code 0 without opening the database) and on-demand respawn by the client.
 * Uses the compiled dist; without a build, the tests are skipped with a warning.
 */

const distMain = fileURLToPath(new URL('../../dist/daemon/main.js', import.meta.url));
const hasDist = fs.existsSync(distMain);

const pipePath = process.platform === 'win32'
  ? `\\\\.\\pipe\\memory-vault.proc.${crypto.randomBytes(6).toString('hex')}`
  : path.join(os.tmpdir(), `memory-vault.proc.${crypto.randomBytes(6).toString('hex')}.sock`);

let vault: TmpVault;
let index: ReturnType<typeof makeTmpIndexDir>;
let configFile: string;
const savedEnv = new Map<string, string | undefined>();
const children: ChildProcess[] = [];

function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

function spawnDaemonProcess(): ChildProcess {
  const child = spawn(process.execPath, [distMain], {
    env: { ...process.env },
    stdio: 'ignore',
    windowsHide: true,
  });
  children.push(child);
  return child;
}

function waitExit(child: ChildProcess, timeoutMs = 10_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('process did not exit in time')), timeoutMs);
    child.once('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}

async function pingUntilUp(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = new DaemonClient({ pipePath, spawnCommand: false, connectWindowMs: 300 });
    try {
      await probe.request('ping');
      probe.close();
      return;
    } catch {
      probe.close();
      if (Date.now() > deadline) throw new Error('daemon did not come up in time');
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

describe.skipIf(!hasDist)('daemon as a process (dist)', () => {
  beforeAll(() => {
    vault = makeTmpVault(SYNTHETIC_VAULT, { eol: 'lf' });
    index = makeTmpIndexDir();
    // Isolated config: the spawned daemon must NEVER touch the real vaults.
    configFile = path.join(index.root, 'config.yml');
    // embeddings off: the real daemon in this test must not pay for ONNX.
    fs.writeFileSync(configFile,
      `vaults:\n  global: ${vault.root.replace(/\\/g, '/')}\ndefault_vault: global\nembeddings:\n  enabled: false\n`, 'utf8');
    setEnv('MEMORY_PIPE_NAME', pipePath);
    setEnv('MEMORY_INDEX_DIR', path.join(index.root, 'idx'));
    setEnv('MEMORY_CONFIG', configFile);
    setEnv('MEMORY_LOCALAPPDATA_DIR', path.join(index.root, 'localappdata'));
  });

  afterAll(async () => {
    for (const c of children) if (c.exitCode === null) c.kill();
    await new Promise((r) => setTimeout(r, 300));
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    index.cleanup();
    vault.cleanup();
  });

  it('a second instance exits with code 0 while the first stays alive (T1 case D)', async () => {
    const first = spawnDaemonProcess();
    await pingUntilUp();

    const second = spawnDaemonProcess();
    expect(await waitExit(second)).toBe(0);

    // The first one keeps responding.
    const probe = new DaemonClient({ pipePath, spawnCommand: false });
    const ping = await probe.request('ping');
    expect(ping.pid).toBe(first.pid);
    probe.close();
  }, 30_000);

  it('killing the daemon is not an error: the client brings up another and search responds', async () => {
    for (const c of children) if (c.exitCode === null) c.kill();
    await new Promise((r) => setTimeout(r, 500));

    const client = new DaemonClient({
      pipePath,
      spawnCommand: { cmd: process.execPath, args: [distMain] },
      connectWindowMs: 15_000,
    });
    // The initial reconcile is asynchronous: waits for the index to be ready.
    const deadline = Date.now() + 20_000;
    let hits = 0;
    for (;;) {
      const res = await client.request('search', { query: 'PROJ-123' });
      hits = res.hits.length;
      if (hits > 0 || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(hits).toBeGreaterThan(0);
    await client.request('shutdown');
    client.close();
  }, 40_000);

  it('after shutdown the pipe is really dead', async () => {
    await new Promise((r) => setTimeout(r, 300));
    const probe = new DaemonClient({ pipePath, spawnCommand: false, connectWindowMs: 300 });
    await expect(probe.request('ping')).rejects.toBeInstanceOf(DaemonUnavailableError);
    probe.close();
  });
});
