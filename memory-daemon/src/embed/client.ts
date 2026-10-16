import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type pino from 'pino';
import { EMBED_DIM, type Embedder } from './embedder.js';

/**
 * Pool of 1 embedding worker: serial queue, per-call timeout, restart with a
 * limit after a crash. When cold or dead, the caller sees isWarm() === false
 * and search degrades instead of failing.
 */

interface Pending {
  resolve(v: Float32Array[]): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

export interface EmbedClientOptions {
  model?: string | undefined;
  workerPath?: string | undefined;
  log?: pino.Logger | undefined;
  warmupTimeoutMs?: number | undefined;
  embedTimeoutMs?: number | undefined;
}

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60_000;

export class EmbedClient implements Embedder {
  readonly model: string;
  readonly dim: number;
  private child: ChildProcess | undefined;
  private readonly pending = new Map<string, Pending>();
  private warm = false;
  private restarts: number[] = [];

  constructor(private readonly opts: EmbedClientOptions = {}) {
    this.model = opts.model ?? 'multilingual-e5-small';
    this.dim = EMBED_DIM[this.model] ?? 384;
  }

  isWarm(): boolean {
    return this.warm && this.child !== undefined;
  }

  async warmup(): Promise<void> {
    await this.send('warmup', undefined, undefined, this.opts.warmupTimeoutMs ?? 180_000);
    this.warm = true;
  }

  embedQueries(texts: string[]): Promise<Float32Array[]> {
    return this.send('embed', 'query', texts, this.opts.embedTimeoutMs ?? 60_000);
  }

  embedPassages(texts: string[]): Promise<Float32Array[]> {
    return this.send('embed', 'passage', texts, this.opts.embedTimeoutMs ?? 120_000);
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.warm = false;
    if (child) {
      child.stdin?.end();
      await new Promise<void>((r) => {
        const t = setTimeout(() => { child.kill(); r(); }, 2000);
        child.once('exit', () => { clearTimeout(t); r(); });
      });
    }
  }

  private ensureChild(): ChildProcess {
    if (this.child) return this.child;

    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) {
      throw new Error(`embedding worker restarted ${MAX_RESTARTS}x in 5 min; embeddings disabled until the daemon restarts`);
    }
    this.restarts.push(now);

    const workerPath = this.opts.workerPath ?? fileURLToPath(new URL('./worker.js', import.meta.url));
    const child = spawn(process.execPath, [workerPath], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      env: { ...process.env, MEMORY_EMBED_MODEL: this.model },
    });
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => this.onLine(line));
    child.on('exit', () => {
      this.child = undefined;
      this.warm = false;
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error('embedding worker died mid-call'));
      }
      this.opts.log?.warn('embedding worker exited');
    });
    this.child = child;
    return child;
  }

  private send(
    op: 'warmup' | 'embed',
    kind: 'query' | 'passage' | undefined,
    texts: string[] | undefined,
    timeoutMs: number,
  ): Promise<Float32Array[]> {
    const child = this.ensureChild();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`embedding timed out after ${timeoutMs} ms (${op})`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(JSON.stringify({ id, op, kind, texts }) + '\n');
    });
  }

  private onLine(line: string): void {
    let msg: { id: string; ok: boolean; vectors?: string[]; error?: string };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (!msg.ok) {
      p.reject(new Error(msg.error ?? 'unknown worker error'));
      return;
    }
    p.resolve((msg.vectors ?? []).map((b64) => {
      const buf = Buffer.from(b64, 'base64');
      return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    }));
  }
}
