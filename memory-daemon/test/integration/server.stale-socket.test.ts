import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { startPipeServer, PipeBusyError, type Handler, type PipeServer } from '../../src/daemon/server.js';
import { getOrCreateToken } from '../../src/core/auth-token.js';
import { PROTOCOL_VERSION } from '../../src/daemon/protocol.js';

/**
 * Phase 0 number-one blocker: on macOS/Linux a Unix domain socket is a FILE
 * that libuv does NOT remove when the daemon exits uncleanly (SIGKILL, power
 * loss). The next start must PROBE the leftover socket and, if no daemon
 * answers, unlink it and reclaim the address — otherwise memory stays dead
 * until the user deletes a file they do not know exists.
 *
 * POSIX-only. On Windows the named pipe dies with the process, so there is no
 * stale file and the whole suite skips (like the 0600 permission tests).
 */

const isWin = process.platform === 'win32';
const silent = pino({ level: 'silent' });

const pingHandlers = new Map<string, Handler>([
  ['ping', () => ({ pid: process.pid })],
]);

/** One authenticated ping over a raw socket; resolves the parsed reply, or
 * undefined if nothing came back before the wait elapsed / the socket errored. */
function rawPing(
  sockPath: string,
  token: string,
  waitMs = 2_000,
): Promise<{ ok: boolean; data?: { pid: number } } | undefined> {
  return new Promise((resolve) => {
    const socket = net.connect({ path: sockPath });
    socket.setEncoding('utf8');
    let buffer = '';
    let settled = false;
    const finish = (v?: { ok: boolean; data?: { pid: number } }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish(undefined), waitMs);
    socket.once('connect', () =>
      socket.write(JSON.stringify({ v: PROTOCOL_VERSION, id: 'ping', method: 'ping', token }) + '\n'));
    socket.on('data', (d: string) => {
      buffer += d;
      const nl = buffer.indexOf('\n');
      if (nl !== -1) finish(JSON.parse(buffer.slice(0, nl).trim()));
    });
    socket.on('error', () => finish(undefined));
    socket.on('close', () => finish(undefined));
  });
}

describe.skipIf(isWin)('unix socket stale-file recovery (Phase 0 blocker)', () => {
  let tmpLocal: string;
  let savedLocal: string | undefined;
  let sockPath: string;
  let token: string;
  const opened: PipeServer[] = [];

  beforeEach(() => {
    // Isolate the per-user token file so server and test client agree on it.
    savedLocal = process.env['MEMORY_LOCALAPPDATA_DIR'];
    tmpLocal = fs.mkdtempSync(path.join(os.tmpdir(), 'memstale-'));
    process.env['MEMORY_LOCALAPPDATA_DIR'] = tmpLocal;
    token = getOrCreateToken();
    sockPath = path.join(os.tmpdir(), `memory-vault.stale.${crypto.randomBytes(6).toString('hex')}.sock`);
    opened.length = 0;
  });

  afterEach(async () => {
    for (const s of opened) await s.close().catch(() => undefined);
    try { fs.unlinkSync(sockPath); } catch { /* gone */ }
    if (savedLocal === undefined) delete process.env['MEMORY_LOCALAPPDATA_DIR'];
    else process.env['MEMORY_LOCALAPPDATA_DIR'] = savedLocal;
    fs.rmSync(tmpLocal, { recursive: true, force: true, maxRetries: 5 });
  });

  it('reclaims a stale socket file left by an unclean exit and serves a request', async () => {
    // Simulate the crash leftover: a file at the socket path with NO listener.
    // bind() then fails with EADDRINUSE and the probe connect is refused, which
    // is exactly what a real orphaned socket produces for the daemon.
    fs.writeFileSync(sockPath, '');
    expect(fs.existsSync(sockPath)).toBe(true);

    const server = await startPipeServer(sockPath, pingHandlers, silent);
    opened.push(server);

    const res = await rawPing(sockPath, token);
    expect(res?.ok).toBe(true);
    expect(res?.data?.pid).toBe(process.pid);
  });

  it('does NOT unlink a live socket: a second start steps aside with PipeBusyError', async () => {
    const first = await startPipeServer(sockPath, pingHandlers, silent);
    opened.push(first);

    // A real daemon is listening: the second start must probe, see it alive,
    // and refuse — never unlink the live socket.
    await expect(startPipeServer(sockPath, pingHandlers, silent)).rejects.toBeInstanceOf(PipeBusyError);

    // The first server is untouched and still serving.
    const res = await rawPing(sockPath, token);
    expect(res?.ok).toBe(true);
    expect(res?.data?.pid).toBe(process.pid);
  });

  it('a graceful close removes the socket file (no leftover for the next start)', async () => {
    const server = await startPipeServer(sockPath, pingHandlers, silent);
    expect(fs.existsSync(sockPath)).toBe(true);
    await server.close();
    expect(fs.existsSync(sockPath)).toBe(false);
  });

  it('creates the socket parent directory when it does not exist yet and serves a request', async () => {
    // A custom MEMORY_RUNTIME_DIR or an unusual XDG_RUNTIME_DIR can name a
    // directory that was never created. The daemon must make the parent before
    // binding; otherwise listen() fails with ENOENT and the daemon dies.
    const missingDir = path.join(tmpLocal, 'no', 'such', 'runtime', 'dir');
    expect(fs.existsSync(missingDir)).toBe(false);
    const nestedSock = path.join(missingDir, `memory-vault.nested.${crypto.randomBytes(4).toString('hex')}.sock`);

    const server = await startPipeServer(nestedSock, pingHandlers, silent);
    opened.push(server);

    // The parent dir now exists and the daemon is serving on the nested socket.
    expect(fs.existsSync(missingDir)).toBe(true);
    const res = await rawPing(nestedSock, token);
    expect(res?.ok).toBe(true);
    expect(res?.data?.pid).toBe(process.pid);
  });
});
