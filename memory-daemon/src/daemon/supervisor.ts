import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type pino from 'pino';
import type { MemoryConfig } from '../core/config.js';
import { externalIndexId, EXTERNAL_SEP } from '../core/vault-scope.js';
import { loadRegistryVocab } from '../core/identifiers.js';
import { indexFile, removeFile, type IndexerContext } from '../index/indexer.js';
import { reconcileVault, type ReconcileResult } from '../index/reconcile.js';
import { startWatcher, type VaultWatcher } from '../index/watcher.js';
import type { Embedder } from '../embed/embedder.js';
import type { VectorIndex } from '../index/search/vector.js';

/**
 * Supervisor: keeps the index alive. Watcher for latency (seconds), periodic
 * reconcile as the source of truth (default 300 s). Watcher events enter an
 * in-memory queue drained serially; the queue size shows up in memory status.
 */

export interface SupervisorOptions {
  db: Database.Database;
  config: MemoryConfig;
  log: pino.Logger;
  /** Default 300_000 ms. */
  reconcileIntervalMs?: number | undefined;
  /** Turns off chokidar (pure reconcile tests). */
  watch?: boolean | undefined;
  /** Incremental embedding; absent = lexical only. */
  embedder?: Embedder | undefined;
  vectorIndex?: VectorIndex | undefined;
  /** Embedding batch size (default 16). */
  embedBatchSize?: number | undefined;
}

interface QueueEvent {
  kind: 'change' | 'unlink';
  vault: string;
  relPath: string;
}

export class Supervisor {
  private readonly contexts = new Map<string, IndexerContext>();
  private readonly queue: QueueEvent[] = [];
  private watcher: VaultWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private draining = false;
  private reconciling = false;
  private lastReconcileAt: number | null = null;
  private stopped = false;
  private watcherReady = false;
  private embedding = false;
  private embedBacklogCount = 0;

  constructor(private readonly opts: SupervisorOptions) {
    for (const [vault, root] of Object.entries(opts.config.vaults)) {
      if (!fs.existsSync(root)) {
        opts.log.warn({ vault, root }, 'configured vault does not exist on disk, ignoring');
        continue;
      }
      this.contexts.set(vault, {
        db: opts.db,
        vaultName: vault,
        vaultRoot: root,
        vocab: loadRegistryVocab(root),
      });
    }
    // External read-only roots: one more context each, under the synthetic
    // `<vault>::<name>` identity, so reconcile/watcher/indexer treat them like
    // any other root while their files stay apart from real vault files. The
    // vocabulary comes from the OWNING vault: the registry is the owner's, and
    // a foreign folder must not get to define identifier vocabulary.
    for (const [name, root] of Object.entries(opts.config.externalRoots ?? {})) {
      if (!fs.existsSync(root.path)) {
        opts.log.warn({ externalRoot: name, path: root.path }, 'configured external root does not exist on disk, ignoring');
        continue;
      }
      const owner = opts.config.vaults[root.vault];
      this.contexts.set(externalIndexId(root.vault, name), {
        db: opts.db,
        vaultName: externalIndexId(root.vault, name),
        vaultRoot: root.path,
        vocab: owner ? loadRegistryVocab(owner) : loadRegistryVocab(root.path),
        external: true,
      });
    }
  }

  /** Indexing context for a vault (the pipeline reindexes after a write). */
  contextFor(vault: string): IndexerContext | undefined {
    return this.contexts.get(vault);
  }

  start(): void {
    // Initial reconcile in the background: daemon startup does not wait.
    setImmediate(() => this.reconcileAll());

    const interval = this.opts.reconcileIntervalMs ?? 300_000;
    this.timer = setInterval(() => this.reconcileAll(), interval);
    this.timer.unref();

    if (this.opts.watch !== false) {
      const roots: Record<string, string> = {};
      for (const [vault, ctx] of this.contexts) roots[vault] = ctx.vaultRoot;
      this.watcher = startWatcher(roots, {
        onChange: (vault, relPath) => this.enqueue({ kind: 'change', vault, relPath }),
        onUnlink: (vault, relPath) => this.enqueue({ kind: 'unlink', vault, relPath }),
      });
      void this.watcher.ready.then(() => { this.watcherReady = true; });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.watcher) await this.watcher.close();
  }

  status(): {
    lastReconcileAt: number | null; reconciling: boolean; queueSize: number;
    watcherReady: boolean; embedBacklog: number; embedderWarm: boolean;
  } {
    return {
      lastReconcileAt: this.lastReconcileAt,
      reconciling: this.reconciling,
      queueSize: this.queue.length,
      // With no watcher configured, "ready" is vacuously true: nothing to wait for.
      watcherReady: this.watcher === undefined ? true : this.watcherReady,
      embedBacklog: this.embedBacklogCount,
      embedderWarm: this.opts.embedder?.isWarm() ?? false,
    };
  }

  /**
   * Embedding backlog: embeds chunks that have no vector for the active model,
   * in batches, yielding the loop between batches so the pipe keeps responding.
   * Reuses a vector from embed_cache when the identical chunk passed here before.
   */
  async embedBacklog(): Promise<number> {
    const { embedder, vectorIndex } = this.opts;
    if (!embedder || !vectorIndex || this.embedding || this.stopped || !embedder.isWarm()) return 0;
    this.embedding = true;
    const batchSize = this.opts.embedBatchSize ?? 16;
    let embedded = 0;
    try {
      const pick = this.opts.db.prepare(`
        SELECT DISTINCT c.chunk_hash, c.context_prefix, c.body
        FROM chunks c
        JOIN files f ON f.id = c.file_id
        LEFT JOIN embeddings e ON e.chunk_hash = c.chunk_hash AND e.model = ?
        WHERE e.chunk_hash IS NULL AND f.is_deleted = 0 AND f.quarantined = 0
        LIMIT ?
      `);
      const cached = this.opts.db.prepare('SELECT vec FROM embed_cache WHERE chunk_hash = ? AND model = ?');
      const insert = this.opts.db.prepare(
        'INSERT OR REPLACE INTO embeddings (chunk_hash, model, dim, vec, embedded_at) VALUES (?, ?, ?, ?, ?)',
      );
      const cache = this.opts.db.prepare(
        'INSERT OR REPLACE INTO embed_cache (chunk_hash, model, vec, last_used) VALUES (?, ?, ?, ?)',
      );

      for (;;) {
        if (this.stopped) break;
        const rows = pick.all(embedder.model, batchSize) as Array<{ chunk_hash: string; context_prefix: string; body: string }>;
        this.embedBacklogCount = rows.length === 0 ? 0 : this.countBacklog();
        if (rows.length === 0) break;

        const misses: typeof rows = [];
        for (const row of rows) {
          const hit = cached.get(row.chunk_hash, embedder.model) as { vec: Buffer } | undefined;
          if (hit) {
            insert.run(row.chunk_hash, embedder.model, embedder.dim, hit.vec, Date.now());
            embedded++;
          } else {
            misses.push(row);
          }
        }
        if (misses.length > 0) {
          const vecs = await embedder.embedPassages(misses.map((r) => `${r.context_prefix}\n${r.body}`));
          for (let i = 0; i < misses.length; i++) {
            const buf = Buffer.from(vecs[i]!.buffer, vecs[i]!.byteOffset, vecs[i]!.byteLength);
            insert.run(misses[i]!.chunk_hash, embedder.model, embedder.dim, buf, Date.now());
            cache.run(misses[i]!.chunk_hash, embedder.model, buf, Date.now());
            embedded++;
          }
        }
        // Yield the event loop: a search on the pipe does not wait for the next batch.
        await new Promise((r) => setImmediate(r));
      }
      if (embedded > 0) {
        vectorIndex.reload();
        this.opts.log.info({ embedded, total: vectorIndex.size }, 'embedding backlog processed');
      }
    } catch (e) {
      this.opts.log.warn(e, 'embedding backlog failed; search stays lexical');
    } finally {
      this.embedding = false;
      this.embedBacklogCount = this.countBacklog();
    }
    return embedded;
  }

  private countBacklog(): number {
    const { embedder } = this.opts;
    if (!embedder) return 0;
    const row = this.opts.db.prepare(`
      SELECT COUNT(DISTINCT c.chunk_hash) AS n
      FROM chunks c
      JOIN files f ON f.id = c.file_id
      LEFT JOIN embeddings e ON e.chunk_hash = c.chunk_hash AND e.model = ?
      WHERE e.chunk_hash IS NULL AND f.is_deleted = 0 AND f.quarantined = 0
    `).get(embedder.model) as { n: number };
    return row.n;
  }

  /** Manual reconcile (reindex handler). */
  reconcile(vault?: string): Record<string, ReconcileResult> {
    const out: Record<string, ReconcileResult> = {};
    this.reconciling = true;
    try {
      for (const [name, ctx] of this.contexts) {
        if (vault && name !== vault) continue;
        out[name] = reconcileVault(ctx);
      }
      this.lastReconcileAt = Date.now();
    } finally {
      this.reconciling = false;
    }
    return out;
  }

  private reconcileAll(): void {
    if (this.stopped || this.reconciling) return;
    try {
      const results = this.reconcile();
      this.opts.log.info({ results: summarize(results) }, 'periodic reconcile');
      void this.embedBacklog();
    } catch (e) {
      this.opts.log.error(e, 'reconcile failed');
    }
  }

  private enqueue(ev: QueueEvent): void {
    // Collapse a repeated event for the same file not yet processed.
    const dup = this.queue.find((q) => q.vault === ev.vault && q.relPath === ev.relPath);
    if (dup) dup.kind = ev.kind;
    else this.queue.push(ev);
    if (!this.draining) {
      this.draining = true;
      setImmediate(() => this.drain());
    }
  }

  private drain(): void {
    try {
      for (let ev = this.queue.shift(); ev; ev = this.queue.shift()) {
        const ctx = this.contexts.get(ev.vault);
        if (!ctx) continue;
        try {
          // A change to the registry swaps the vocabulary of the whole vault.
          // The reconcile is FORCED because the stored identifiers were built
          // with the old vocabulary and the content hashes cannot see that.
          // The registry may live at the root or in Topics/, so match by name.
          // Never for an external context: its vocabulary is the OWNER vault's,
          // and a _registry.md a foreign tool drops in its folder must not get
          // to redefine identifier vocabulary (it still indexes as a plain file).
          if (!ctx.external && ev.relPath.toLowerCase().split('/').pop() === '_registry.md') {
            ctx.vocab = loadRegistryVocab(ctx.vaultRoot);
            const r = reconcileVault(ctx, { force: true });
            this.opts.log.info(
              { vault: ev.vault, indexed: r.indexed, elapsedMs: r.elapsedMs },
              'registry changed; vault reindexed with the new vocabulary',
            );
            // The vault's external roots share its vocabulary, so their stored
            // identifiers went stale with the same change. Without this, an
            // identifier added to the registry would keep missing external
            // files in the bypass until they happened to change on disk.
            for (const [name, extCtx] of this.contexts) {
              if (!extCtx.external || !name.startsWith(`${ev.vault}${EXTERNAL_SEP}`)) continue;
              extCtx.vocab = ctx.vocab;
              const er = reconcileVault(extCtx, { force: true });
              this.opts.log.info(
                { externalRoot: name, indexed: er.indexed, elapsedMs: er.elapsedMs },
                'registry changed; external root reindexed with the new vocabulary',
              );
            }
          }
          if (ev.kind === 'unlink') {
            removeFile(ctx, ev.relPath);
          } else {
            indexFile(ctx, ev.relPath);
          }
          this.opts.log.debug({ ev }, 'watcher event applied');
        } catch (e) {
          // The file may have vanished between the event and processing.
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') removeFile(ctx, ev.relPath);
          else this.opts.log.warn(e, `failed to apply event ${ev.kind} ${ev.relPath}`);
        }
      }
    } finally {
      this.draining = false;
      // A new chunk from the watcher enters the vector channel without waiting for the reconcile.
      void this.embedBacklog();
    }
  }
}

function summarize(results: Record<string, ReconcileResult>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [vault, r] of Object.entries(results)) {
    out[vault] = `${r.indexed} indexed, ${r.removed} removed, ${r.unchanged} unchanged, ${r.elapsedMs} ms`;
  }
  return out;
}
