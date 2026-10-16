import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { startPipeServer, type Handler, type PipeServer } from '../../src/daemon/server.js';
import { ToolError } from '../../src/daemon/write-pipeline.js';
import { DaemonClient, RpcError } from '../../src/mcp/client.js';

/**
 * Boot-window contract (item 7): the daemon's ready() guard throws a
 * ToolError('DAEMON_STARTING', ...) so the code and the tailored hint cross the
 * pipe intact. The dispatch preserves code+hint ONLY for ToolError; a plain
 * Error collapses to INTERNAL and the hint is lost. These tests drive the real
 * pipe dispatch with both shapes to prove the difference.
 */

const silent = pino({ level: 'silent' });

function testPipe(): string {
  const id = crypto.randomBytes(6).toString('hex');
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\memory-vault.starting.${id}`
    : path.join(os.tmpdir(), `memory-vault.starting.${id}.sock`);
}

describe('boot-window DAEMON_STARTING (item 7)', () => {
  let tmpLocal: string;
  let savedLocal: string | undefined;
  let pipePath: string;
  let server: PipeServer;
  let client: DaemonClient;

  beforeEach(async () => {
    // Isolate the auth token so the client and server agree without touching
    // the real per-user dir.
    savedLocal = process.env['MEMORY_LOCALAPPDATA_DIR'];
    tmpLocal = fs.mkdtempSync(path.join(os.tmpdir(), 'memstart-'));
    process.env['MEMORY_LOCALAPPDATA_DIR'] = tmpLocal;
    pipePath = testPipe();

    // Two handlers stand in for the boot window: one throws the real ToolError
    // the ready() guard now throws; the other throws the OLD plain Error shape
    // (hint attached as a property) to show what used to be lost.
    const handlers = new Map<string, Handler>([
      ['search', () => {
        throw new ToolError('DAEMON_STARTING', 'Daemon still starting up.', 'Wait ~1s and repeat the call.');
      }],
      ['status', () => {
        throw Object.assign(new Error('Daemon still starting up.'), { hint: 'Wait ~1s and repeat the call.' });
      }],
    ]);
    server = await startPipeServer(pipePath, handlers, silent);
    client = new DaemonClient({ pipePath, spawnCommand: false });
  });

  afterEach(async () => {
    client.close();
    await server.close();
    if (savedLocal === undefined) delete process.env['MEMORY_LOCALAPPDATA_DIR'];
    else process.env['MEMORY_LOCALAPPDATA_DIR'] = savedLocal;
    fs.rmSync(tmpLocal, { recursive: true, force: true, maxRetries: 5 });
  });

  it('a ToolError crosses the pipe with the DAEMON_STARTING code and its hint intact', async () => {
    await expect(client.request('search', { query: 'x' })).rejects.toSatisfy(
      (e: unknown) => e instanceof RpcError
        && e.code === 'DAEMON_STARTING'
        && e.hint === 'Wait ~1s and repeat the call.',
    );
  });

  it('a plain Error with an attached hint collapses to INTERNAL and loses the hint', async () => {
    // This is the pre-fix behavior: proves why the guard had to throw ToolError.
    await expect(client.request('status')).rejects.toSatisfy(
      (e: unknown) => e instanceof RpcError
        && e.code === 'INTERNAL'
        && e.hint !== 'Wait ~1s and repeat the call.',
    );
  });
});
