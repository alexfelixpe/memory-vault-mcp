import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { startPipeServer, type Handler, type PipeServer } from '../../src/daemon/server.js';
import { getOrCreateToken, tokenPath } from '../../src/core/auth-token.js';
import { PROTOCOL_VERSION } from '../../src/daemon/protocol.js';

/**
 * Security finding #1: the IPC socket must authenticate. A same-user token
 * gates every method; a request with no token or a wrong token never reaches a
 * handler (no vault data is read or written). The token lives in the per-user
 * OS data dir, isolated here via MEMORY_LOCALAPPDATA_DIR.
 */

const silent = pino({ level: 'silent' });

function testPipe(): string {
  const id = crypto.randomBytes(6).toString('hex');
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\memory-vault.auth.${id}`
    : path.join(os.tmpdir(), `memory-vault.auth.${id}.sock`);
}

/**
 * Raw NDJSON round-trip that bypasses DaemonClient (so it sends exactly what we
 * put on the wire, token or not). Resolves with the first response line, or
 * undefined if the server sent nothing before closing / the wait elapsed.
 */
function rawRequest(pipePath: string, payload: object, waitMs = 2_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = net.connect({ path: pipePath });
    socket.setEncoding('utf8');
    let buffer = '';
    let settled = false;
    const finish = (line?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(line);
    };
    const timer = setTimeout(() => finish(undefined), waitMs);
    socket.once('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', (d: string) => {
      buffer += d;
      const nl = buffer.indexOf('\n');
      if (nl !== -1) finish(buffer.slice(0, nl).trim());
    });
    socket.on('close', () => finish(undefined));
    socket.on('error', () => finish(undefined));
  });
}

describe('daemon IPC authentication (security finding #1)', () => {
  let tmpLocal: string;
  let savedLocal: string | undefined;
  let pipePath: string;
  let server: PipeServer;
  let token: string;
  // A stand-in for a real read/write handler; the spy proves it is never
  // reached without the token (the "no vault data leaks" guarantee).
  const searchHandler = vi.fn<Handler>(async () => ({ hits: ['secret-vault-data'] }));

  beforeEach(async () => {
    savedLocal = process.env['MEMORY_LOCALAPPDATA_DIR'];
    tmpLocal = fs.mkdtempSync(path.join(os.tmpdir(), 'memauth-'));
    process.env['MEMORY_LOCALAPPDATA_DIR'] = tmpLocal;
    searchHandler.mockClear();
    pipePath = testPipe();
    const handlers = new Map<string, Handler>([['search', searchHandler]]);
    server = await startPipeServer(pipePath, handlers, silent);
    token = getOrCreateToken();
  });

  afterEach(async () => {
    await server.close();
    if (savedLocal === undefined) delete process.env['MEMORY_LOCALAPPDATA_DIR'];
    else process.env['MEMORY_LOCALAPPDATA_DIR'] = savedLocal;
    fs.rmSync(tmpLocal, { recursive: true, force: true, maxRetries: 5 });
  });

  it('a request without a token is refused with AUTH_FAILED and never reaches the handler', async () => {
    const line = await rawRequest(pipePath, {
      v: PROTOCOL_VERSION, id: 'no-token', method: 'search', params: { query: 'x' },
    });
    expect(line).toBeDefined();
    const res = JSON.parse(line!) as { ok: boolean; error?: { code: string } };
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('AUTH_FAILED');
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('a request with the wrong token is refused with AUTH_FAILED', async () => {
    const wrong = crypto.randomBytes(32).toString('hex');
    const line = await rawRequest(pipePath, {
      v: PROTOCOL_VERSION, id: 'wrong-token', method: 'search', params: { query: 'x' }, token: wrong,
    });
    expect(line).toBeDefined();
    const res = JSON.parse(line!) as { ok: boolean; error?: { code: string } };
    expect(res.error?.code).toBe('AUTH_FAILED');
    expect(searchHandler).not.toHaveBeenCalled();
  });

  it('a request with the correct token reaches the handler and returns data', async () => {
    const line = await rawRequest(pipePath, {
      v: PROTOCOL_VERSION, id: 'ok', method: 'search', params: { query: 'x' }, token,
    });
    expect(line).toBeDefined();
    const res = JSON.parse(line!) as { ok: boolean; data?: { hits: string[] } };
    expect(res.ok).toBe(true);
    expect(res.data?.hits).toContain('secret-vault-data');
    expect(searchHandler).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.platform !== 'win32')('locks the unix socket file to mode 0600', () => {
    const mode = fs.statSync(pipePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.runIf(process.platform !== 'win32')('stores the token file with mode 0600', () => {
    const mode = fs.statSync(tokenPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
