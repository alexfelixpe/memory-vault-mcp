import fs from 'node:fs';
import path from 'node:path';
import { toVaultRelPosix } from '../core/paths.js';
import { indexFile, removeFile, type IndexerContext } from './indexer.js';
import { SCANNER_VERSION } from '../security/scan-injection.js';

/**
 * Reconcile: a full scan of the vault comparing mtime+size against the
 * index, re-hashing only what changed. It is the SOURCE OF TRUTH for the
 * index; the watcher (Increment 2) is only a latency optimization.
 */

const SKIP_DIRS = new Set(['.git', '.obsidian', '.memory', '.trash', 'node_modules', 'quarantine']);

export interface ReconcileResult {
  scanned: number;
  indexed: number;
  unchanged: number;
  removed: number;
  skipped: string[];
  elapsedMs: number;
}

function* walkMarkdown(dir: string): Generator<string> {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name.toLowerCase())) yield* walkMarkdown(path.join(dir, e.name));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      yield path.join(dir, e.name);
    }
  }
}

export function reconcileVault(ctx: IndexerContext, opts?: { force?: boolean }): ReconcileResult {
  const force = opts?.force === true;
  const started = Date.now();
  const result: ReconcileResult = { scanned: 0, indexed: 0, unchanged: 0, removed: 0, skipped: [], elapsedMs: 0 };

  const knownStmt = ctx.db
    .prepare('SELECT mtime_ns, size_bytes, scanner_version FROM files WHERE vault = ? AND path_lower = ? AND is_deleted = 0')
    .safeIntegers(true); // mtime_ns does not fit in Number without loss

  const seen = new Set<string>();
  for (const abs of walkMarkdown(ctx.vaultRoot)) {
    const rel = toVaultRelPosix(ctx.vaultRoot, abs);
    const relLower = rel.toLowerCase();
    seen.add(relLower);
    result.scanned++;

    const stat = fs.statSync(abs, { bigint: true });
    const known = knownStmt.get(ctx.vaultName, relLower) as
      { mtime_ns: bigint; size_bytes: bigint; scanner_version: bigint } | undefined;
    // `force` skips the mtime shortcut: a vocabulary change must rebuild the
    // stored identifiers of files whose content did not move at all. A stale
    // scanner_version skips it too: a version bump promises a re-index, and an
    // untouched file would otherwise dodge it forever (found 2026-07-29, when
    // the tier backfill reached zero files through this shortcut).
    if (!force && known && known.mtime_ns === stat.mtimeNs && known.size_bytes === BigInt(stat.size)
      && Number(known.scanner_version) >= SCANNER_VERSION) {
      result.unchanged++;
      continue;
    }
    const r = indexFile(ctx, rel, opts);
    if (r === 'indexed') result.indexed++;
    else if (r === 'unchanged') result.unchanged++;
    else result.skipped.push(rel);
  }

  // What is in the index but gone from disk leaves the index.
  const inDb = ctx.db
    .prepare('SELECT path_lower FROM files WHERE vault = ? AND is_deleted = 0')
    .all(ctx.vaultName) as Array<{ path_lower: string }>;
  for (const row of inDb) {
    if (!seen.has(row.path_lower)) {
      removeFile(ctx, row.path_lower);
      result.removed++;
    }
  }

  result.elapsedMs = Date.now() - started;
  ctx.db.prepare('INSERT INTO index_log (at, action, path, detail) VALUES (?, ?, ?, ?)')
    .run(Date.now(), 'reconcile', ctx.vaultName, JSON.stringify({ ...result, skipped: result.skipped.length }));
  return result;
}
