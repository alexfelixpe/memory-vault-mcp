import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { toVaultRelPosix } from '../core/paths.js';

/**
 * chokidar watcher over the vaults. It is a latency OPTIMIZATION, never the
 * source of truth: whatever it misses (an unusual editor, a mass git checkout,
 * a network share) the periodic reconcile catches. awaitWriteFinish avoids
 * indexing a half-written file while Obsidian is still saving.
 */

const SKIP_SEGMENTS = new Set(['.git', '.obsidian', '.memory', '.trash', 'node_modules', 'quarantine']);

export interface WatcherCallbacks {
  onChange(vault: string, relPath: string): void;
  onUnlink(vault: string, relPath: string): void;
}

export interface VaultWatcher {
  /** Resolves when the initial scan finishes: before that, a new event may
   * be swallowed by ignoreInitial. */
  ready: Promise<void>;
  close(): Promise<void>;
}

function shouldIgnore(abs: string): boolean {
  return abs.split(path.sep).some((seg) => SKIP_SEGMENTS.has(seg.toLowerCase()));
}

export function startWatcher(
  vaults: Record<string, string>,
  cb: WatcherCallbacks,
): VaultWatcher {
  const roots = Object.entries(vaults);
  const resolve = (abs: string): { vault: string; rel: string } | undefined => {
    for (const [vault, root] of roots) {
      const rel = path.relative(path.resolve(root), abs);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        return { vault, rel: rel.split(path.sep).join('/') };
      }
    }
    return undefined;
  };

  const watcher: FSWatcher = chokidar.watch(roots.map(([, root]) => root), {
    ignoreInitial: true,               // the initial state is the reconcile's job
    ignored: (p: string) => shouldIgnore(p),
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  });

  const emit = (kind: 'change' | 'unlink') => (abs: string): void => {
    if (!abs.toLowerCase().endsWith('.md')) return;
    const hit = resolve(abs);
    if (!hit) return;
    if (kind === 'change') cb.onChange(hit.vault, hit.rel);
    else cb.onUnlink(hit.vault, hit.rel);
  };

  watcher.on('add', emit('change'));
  watcher.on('change', emit('change'));
  watcher.on('unlink', emit('unlink'));

  const ready = new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
  return { ready, close: () => watcher.close() };
}
