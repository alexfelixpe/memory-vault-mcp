import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipeName } from '../core/ipc-address.js';
import { getOrCreateToken } from '../core/auth-token.js';
import { PROTOCOL_VERSION, type MethodMap, type Response } from '../daemon/protocol.js';

/**
 * Daemon client over the named pipe. If the pipe does not exist, it starts the
 * daemon on demand (detached, stdio ignored, unref) and retries with backoff:
 * a dead daemon never surfaces as an error to the caller (Increment 2's
 * criterion).
 */

export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export class DaemonUnavailableError extends Error {
  readonly code = 'DAEMON_UNAVAILABLE';
  constructor(detail: string) {
    super(`Daemon unreachable: ${detail}`);
  }
}

export interface ClientOptions {
  pipePath?: string | undefined;
  /** false turns off spawn (pure probing); undefined uses the memoryd from dist. */
  spawnCommand?: { cmd: string; args: string[] } | false | undefined;
  requestTimeoutMs?: number | undefined;
  /** Total connection-attempt window (spawn included). */
  connectWindowMs?: number | undefined;
}

interface Pending {
  resolve(data: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export class DaemonClient {
  private socket: net.Socket | undefined;
  private buffer = '';
  private readonly pending = new Map<string, Pending>();
  private spawned = false;

  constructor(private readonly opts: ClientOptions = {}) {}

  async request<M extends keyof MethodMap>(
    method: M,
    params?: MethodMap[M]['params'],
  ): Promise<MethodMap[M]['data']> {
    const socket = await this.ensureConnected();
    const id = crypto.randomUUID();
    // Same-user shared secret, on every request. Read here (cached) rather than
    // at construction so a client built before the daemon still authenticates.
    const token = getOrCreateToken();
    const timeoutMs = this.opts.requestTimeoutMs ?? (method === 'reindex' ? 120_000 : 5_000);

    return new Promise<MethodMap[M]['data']>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DaemonUnavailableError(`timeout of ${timeoutMs} ms on ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (data) => resolve(data as MethodMap[M]['data']),
        reject,
        timer,
      });
      socket.write(JSON.stringify({ v: PROTOCOL_VERSION, id, method, params, token }) + '\n');
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  private async ensureConnected(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;

    const windowMs = this.opts.connectWindowMs ?? 6_000;
    const deadline = Date.now() + windowMs;
    let delay = 50;
    let lastError = 'no attempt';

    for (;;) {
      try {
        return await this.connectOnce();
      } catch (e) {
        lastError = e instanceof Error ? (e as NodeJS.ErrnoException).code ?? e.message : String(e);
        if (this.opts.spawnCommand === false) throw new DaemonUnavailableError(lastError);
        if (!this.spawned) this.spawnDaemon();
        if (Date.now() + delay > deadline) throw new DaemonUnavailableError(lastError);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 1.8, 800);
      }
    }
  }

  private connectOnce(): Promise<net.Socket> {
    const pipePath = this.opts.pipePath ?? pipeName();
    return new Promise((resolve, reject) => {
      const socket = net.connect({ path: pipePath });
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        this.socket = socket;
        this.buffer = '';
        socket.on('data', (data: string) => this.onData(data));
        socket.on('close', () => this.onClose());
        socket.on('error', () => { /* close handles the pending ones */ });
        resolve(socket);
      });
      socket.once('error', (e) => {
        socket.destroy();
        reject(e);
      });
    });
  }

  private spawnDaemon(): void {
    this.spawned = true;
    // spawnCommand === false never reaches here (ensureConnected short-circuits).
    const cmd = this.opts.spawnCommand === false || this.opts.spawnCommand === undefined
      ? { cmd: process.execPath, args: [fileURLToPath(new URL('../daemon/main.js', import.meta.url))] }
      : this.opts.spawnCommand;
    // Reset the flag after a while: if the daemon dies again later, a future
    // request can try to start another one.
    setTimeout(() => { this.spawned = false; }, 10_000).unref();
    const child = spawn(cmd.cmd, cmd.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: path.dirname(cmd.args[0] ?? process.cwd()),
    });
    child.unref();
  }

  private onData(data: string): void {
    this.buffer += data;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line === '') continue;
      let res: Response;
      try {
        res = JSON.parse(line) as Response;
      } catch {
        continue; // corrupted line: the pending timeout resolves the rest
      }
      const p = this.pending.get(res.id);
      if (!p) continue;
      this.pending.delete(res.id);
      clearTimeout(p.timer);
      if (res.ok) {
        p.resolve(res.data);
      } else {
        const { code, message, hint, ...data } = res.error;
        p.reject(new RpcError(code, message, hint, data));
      }
    }
  }

  private onClose(): void {
    this.socket = undefined;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new DaemonUnavailableError('connection dropped mid-call'));
    }
  }
}
