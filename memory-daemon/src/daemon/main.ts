#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import type Database from 'better-sqlite3';
import { loadConfig, type MemoryConfig } from '../core/config.js';
import { readableVaults, GLOBAL_VAULT } from '../core/vault-scope.js';
import { pipeName } from '../core/ipc-address.js';
import { localAppDataDir } from '../core/paths.js';
import { openIndexDb } from '../index/db.js';
import { buildSearchContext } from '../index/context.js';
import { memorySearch, type SearchRequest, type VectorChannel } from '../index/search/search.js';
import { BruteForceVectorIndex, type VectorIndex } from '../index/search/vector.js';
import { EmbedClient } from '../embed/client.js';
import type { Embedder } from '../embed/embedder.js';
import { startPipeServer, PipeBusyError, type Handler, type PipeServer } from './server.js';
import { Supervisor } from './supervisor.js';
import { writeHandlers } from './handlers/index.js';
import {
  runGet, runMutate, ToolError,
  type WriteDeps, type MemoryFile,
} from './write-pipeline.js';
import { CaptureManager } from './capture/index.js';
import { buildRetrievalPush } from './capture/push.js';
import { runVaultBackup, vaultBackupDue } from './backup/vault-backup.js';
import type { ChatFn } from './capture/extractor.js';
import type { PingData, ReindexParams, StatusData } from './protocol.js';

/**
 * bin memoryd. Mandatory boot order (section 11 of the plan): create the pipe
 * BEFORE opening the database. The exclusive listen is the mutex: the second
 * instance gets EADDRINUSE and exits with code 0 without ever touching SQLite.
 */

const VERSION = '0.1.0';

export interface DaemonOptions {
  pipePath?: string | undefined;
  config?: MemoryConfig | undefined;
  indexRootDir?: string | undefined;
  reconcileIntervalMs?: number | undefined;
  watch?: boolean | undefined;
  log?: pino.Logger | undefined;
  /** Embedder override (tests with FakeEmbedder); null turns it off. */
  embedder?: Embedder | null | undefined;
  /** Triage transport (tests inject a fake). */
  chat?: ChatFn | undefined;
  turnsPerPass?: number | undefined;
}

export type DaemonStart =
  | { alreadyRunning: true }
  | { alreadyRunning: false; pid: number; close(): Promise<void> };

function defaultLogger(): pino.Logger {
  // A detached daemon has stdio ignored: the log goes to a file, not stderr.
  // SYNCHRONOUS destination: the duplicate instance logs and exits at once,
  // and pino's async SonicBoom blows up if the process dies before the open.
  const dir = path.join(localAppDataDir(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return pino(
    { name: 'memoryd', level: process.env['MEMORY_LOG_LEVEL'] ?? 'info' },
    pino.destination({ dest: path.join(dir, 'memoryd.log'), sync: true }),
  );
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonStart> {
  const log = opts.log ?? defaultLogger();
  const startedAt = Date.now();
  const config = opts.config ?? loadConfig({});

  // State filled AFTER the pipe comes up; a request in the boot window gets
  // DAEMON_STARTING instead of a crash.
  const state: {
    db?: Database.Database;
    supervisor?: Supervisor;
    embedder?: Embedder;
    vectorIndex?: VectorIndex;
    vectorChannel?: VectorChannel;
  } = {};
  const ready = <T>(fn: (db: Database.Database, sup: Supervisor) => T): T => {
    if (!state.db || !state.supervisor) {
      // ToolError so the code+hint survive the pipe intact: the dispatch only
      // preserves code and hint for ToolError; a plain Error becomes INTERNAL.
      throw new ToolError('DAEMON_STARTING', 'Daemon still starting up.', 'Wait ~1s and repeat the call.');
    }
    return fn(state.db, state.supervisor);
  };

  let server: PipeServer;
  const handlers = new Map<string, Handler>([
    ['ping', (): PingData => ({
      pid: process.pid, version: VERSION, uptimeMs: Date.now() - startedAt, protocol: 1,
    })],
    ['search', (params): unknown => ready((db) => {
      const req = params as SearchRequest;
      // Vault read isolation is decided HERE, on the server, from the scope the
      // caller resolved: one vault name (or null for "no vault at all"), plus
      // whether that repo invited the shared vault in. The MCP proxy sets both
      // last; the CLI may send 'all'. The daemon never accepts a ready-made list
      // of vaults from a client, so a request cannot widen what it may read.
      // `share_global` defaults to false here, so a request that omits it can
      // only narrow, never widen.
      const vaults = readableVaults(config, req.vault, req.share_global);
      return memorySearch(buildSearchContext(db, config, state.vectorChannel, vaults), req);
    })],
    ['status', (): StatusData => ready((db, sup) => {
      const files = db.prepare(
        'SELECT vault, COUNT(*) AS count FROM files WHERE is_deleted = 0 GROUP BY vault',
      ).all() as Array<{ vault: string; count: number }>;
      const chunks = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
      const s = sup.status();
      return {
        pid: process.pid, uptimeMs: Date.now() - startedAt,
        lastReconcileAt: s.lastReconcileAt, reconciling: s.reconciling,
        watcherReady: s.watcherReady, watcherQueueSize: s.queueSize,
        embedderWarm: s.embedderWarm, embedBacklog: s.embedBacklog,
        vectorSize: state.vectorIndex?.size ?? 0,
        files, chunks,
        // Authoritative egress state: a present key means capture is ON. Never
        // send the key itself, only the boolean.
        captureOn: !!config.triage,
        captureNotice: capture?.notice(),
      };
    })],
    ['reindex', (params): unknown => ready((_db, sup) =>
      sup.reconcile((params as ReindexParams | undefined)?.vault ?? undefined),
    )],
    ['shutdown', (): { stopping: true } => {
      // Respond before closing: the client sees the ack, then the pipe dies.
      setTimeout(() => { void close(); }, 20).unref();
      return { stopping: true };
    }],
  ]);

  // Write handlers: same ready-guards; the db arrives via a lazy getter.
  const writeDeps: WriteDeps = {
    get db() {
      if (!state.db) throw new ToolError('DAEMON_STARTING', 'Daemon still starting up.', 'Wait ~1s and repeat the call.');
      return state.db;
    },
    config,
    log,
    indexerCtxFor: (vault) => state.supervisor?.contextFor(vault),
    // The session's whole read scope travels with the push, so the injected
    // memories obey the same rule a search from that repo would, never the
    // daemon's own default vault.
    buildPush: (cwd, scope) => ready((db) => buildRetrievalPush(db, config, cwd, state.vectorChannel, scope)),
  };
  for (const [method, handler] of writeHandlers(writeDeps)) handlers.set(method, handler);

  // Capture (Increment 5): turn counter + background pass.
  // autoWrite (Increment 6): a safe class (closed decision, 2026-07-21) goes in on its own,
  // through the SAME pipeline gate; a failure discards the item, never a crash.
  // `vault` is the SESSION's vault, resolved by the capture pass from the repo
  // the session runs in. Never config.defaultVault: the daemon is shared, so its
  // default is the vault of whatever repo started it, and in a multi-client
  // setup that is another client's. A session whose marker cannot be honoured
  // resolves to 'global', which makes a 'project' target refuse here; the item
  // is then dropped instead of landing in the wrong vault.
  const autoWrite = async (item: { text: string; target: string; section: string }, vault: string): Promise<boolean> => {
    const file = item.target as MemoryFile;
    const target = runGet(config, { file, vault }) as { sections: Array<{ name: string; section_hash: string; auto: boolean }> };
    const section = target.sections.find((s) => s.name.toLowerCase() === item.section.toLowerCase())
      ?? target.sections.find((s) => s.auto);
    if (!section) return false;
    await runMutate(writeDeps, {
      file,
      vault,
      expect: { sectionHash: section.section_hash },
      ops: [{ op: 'add', section: section.name, text: item.text, source: 'inferred' }],
      actor: 'auto_promote',
    });
    return true;
  };
  const captureDeps = { config, log, chat: opts.chat, turnsPerPass: opts.turnsPerPass, autoWrite };
  let capture: CaptureManager | undefined;
  const captureMgr = (): CaptureManager => ready((db) => {
    capture ??= new CaptureManager({ ...captureDeps, db });
    return capture;
  });
  // `cwd` is the session's repo (the hook sends it). It travels into the capture
  // pass so the triage context follows the session's own vault; the daemon's
  // default vault is another client's in a multi-client setup.
  handlers.set('capture.turn', (params) => {
    const p = params as { session_id: string; transcript_path: string; cwd?: string };
    const mgr = captureMgr();
    const result = mgr.onTurn(p.session_id, p.transcript_path, p.cwd);
    // Piggyback the standing auth problem on the per-turn reply: the Stop hook
    // is the one channel that reaches the person INSIDE the session.
    const notice = mgr.hookNotice();
    return notice ? { ...result, notice } : result;
  });
  handlers.set('capture.flush', (params) => {
    const p = params as { session_id: string; transcript_path: string; cwd?: string };
    captureMgr().flush(p.session_id, p.transcript_path, p.cwd);
    return { flushing: true };
  });

  const pipePath = opts.pipePath ?? pipeName();
  try {
    server = await startPipeServer(pipePath, handlers, log);
  } catch (e) {
    if (e instanceof PipeBusyError) {
      log.info({ pipePath }, 'a live daemon already exists; exiting without touching the database');
      return { alreadyRunning: true };
    }
    throw e;
  }

  // Pipe guaranteed: now the database (single instance => single writer).
  const dbOpts = opts.indexRootDir !== undefined ? { rootDir: opts.indexRootDir } : {};
  state.db = openIndexDb(dbOpts);

  // Embeddings: optional by config and by override; a failure here never
  // brings the daemon down — search degrades to lexical (risk 1 of the plan).
  if (opts.embedder !== null && (opts.embedder !== undefined || config.embeddings.enabled)) {
    state.embedder = opts.embedder ?? new EmbedClient({ model: config.embeddings.model, log });
    state.vectorIndex = new BruteForceVectorIndex(state.db, state.embedder.model, state.embedder.dim);
    state.vectorIndex.reload();
    const embedder = state.embedder;
    const vectorIndex = state.vectorIndex;
    state.vectorChannel = {
      warm: () => embedder.isWarm() && vectorIndex.size > 0,
      // The readable set AND the scope reach the brute-force scan, so neither
      // costs the caller recall: the pool is filled with rows it may actually
      // see and actually asked for.
      search: async (queryText, pool, minCosine, vaults, scope) => {
        const [vec] = await embedder.embedQueries([queryText]);
        return vec ? vectorIndex.search(vec, pool, minCosine, vaults, scope) : [];
      },
    };
  }

  state.supervisor = new Supervisor({
    db: state.db, config, log,
    reconcileIntervalMs: opts.reconcileIntervalMs,
    watch: opts.watch,
    embedder: state.embedder,
    vectorIndex: state.vectorIndex,
  });
  state.supervisor.start();

  // Vault backup: checks every hour; runs when the stamp passes 24 h (the timer
  // misses its trigger when the machine hibernates; the stamp does not).
  handlers.set('backup', () => ready((db) => runVaultBackup(db, config, log)));
  // Guard on state.db.open, not just existence: on shutdown the db is closed but
  // state.db still references it, and vaultBackupDue()'s prepare() on a closed db
  // would throw synchronously (outside the runVaultBackup .catch) as an unhandled
  // error. Checking .open skips the run once the daemon is closing.
  const maybeBackup = (): void => {
    if (state.db?.open && vaultBackupDue(state.db)) {
      void runVaultBackup(state.db, config, log).catch((e) => log.warn(e, 'vault backup failed'));
    }
  };
  const backupTimer = setInterval(maybeBackup, 3_600_000);
  backupTimer.unref();
  setImmediate(maybeBackup);

  // Async warmup: the boot does not wait for ONNX; once it warms up, the
  // backlog runs and the vector channel starts to count.
  if (state.embedder) {
    void state.embedder.warmup()
      .then(() => state.supervisor?.embedBacklog())
      .catch((e) => log.warn(e, 'embedder warmup failed; search stays lexical'));
  }

  log.info({ pid: process.pid, pipePath, vaults: Object.keys(config.vaults), embeddings: !!state.embedder }, 'memoryd up');

  // A repo marker naming an unknown vault silently falls back to the default
  // vault, which decides both where writes land and what reads may see. Say it
  // out loud in the log rather than letting it stay invisible.
  if (config.markerWarning) log.warn({ defaultVault: config.defaultVault }, config.markerWarning);

  // Egress transparency (security finding #5): capture is the only feature that
  // sends data off the machine, so name the destination once at startup and
  // never do it silently. A present key means capture is ON. The key value is
  // never logged. No key means zero egress (the documented safe default).
  if (config.triage?.backend === 'claude-cli') {
    log.info(
      { backend: 'claude-cli', model: config.triage.model },
      'capture ON: session text is sent to Anthropic through the local Claude CLI, on your own Claude account, for triage; secrets and tool output are removed first',
    );
  } else if (config.triage) {
    log.info(
      { endpoint: 'openrouter.ai', model: config.triage.model },
      'capture ON: session text is sent to OpenRouter, a third-party LLM API hosted in the United States, for triage; secrets and tool output are removed first',
    );
  } else {
    log.info('capture OFF: no triage backend configured; no session text leaves this machine');
  }

  // Single promise: whoever calls close() again WAITS for the same shutdown
  // (the shutdown test needs to wait for the database to really close).
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= (async () => {
      log.info('memoryd shutting down');
      await state.supervisor?.stop();
      await state.embedder?.close();
      await server.close();
      state.db?.close();
      if (isMain) process.exit(0);
    })();
    return closing;
  }

  return { alreadyRunning: false, pid: process.pid, close };
}

/**
 * True only when this file is the process entry point (the real `memoryd` run),
 * false when a test imports startDaemon. Both sides are compared by their REAL
 * path (symlinks resolved): `npm link` / `npm install -g` expose the bin through
 * a symlink, so process.argv[1] is the link while import.meta.url is already the
 * resolved target. Without realpath the two never match and a linked `memoryd`
 * would silently no-op. Not triggered today (the daemon is spawned by absolute
 * path), so this is a safety fix for the linked-bin case only — mirrors
 * cli/memory.ts isMainModule().
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fs.realpathSync(path.resolve(entry)) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that cannot be resolved (removed, permission denied) is not our entry.
    return false;
  }
}

const isMain = isMainModule();

if (isMain) {
  startDaemon()
    .then((started) => {
      if (started.alreadyRunning) process.exit(0);
      // Unix backstop: a normal process exit must never leave a stale socket.
      // close() already unlinks on a graceful shutdown (SIGINT/SIGTERM route
      // through it); this synchronous 'exit' handler covers process.exit paths
      // that bypass close(). It does NOT fire on SIGKILL/power loss — that is
      // exactly the case the next start's probe-unlink recovery handles. No-op
      // on Windows, where the pipe dies with the process. Registered only here
      // (the real daemon), never in startDaemon, so tests that start many
      // in-process daemons do not accumulate 'exit' listeners.
      if (process.platform !== 'win32') {
        const sock = pipeName();
        process.on('exit', () => {
          try { fs.unlinkSync(sock); } catch { /* already gone: nothing to do */ }
        });
      }
      process.on('SIGINT', () => void started.close());
      process.on('SIGTERM', () => void started.close());
    })
    .catch((e) => {
      defaultLogger().error(e, 'memoryd failed to start');
      process.exit(1);
    });
}
