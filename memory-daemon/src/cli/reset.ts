import fs from 'node:fs';
import path from 'node:path';
import { indexRootDir } from '../core/paths.js';
import type { MemoryConfig } from '../core/config.js';

/**
 * `memory reset` — clear the rebuildable state, keep everything in the vault.
 * Split from memory.ts as a PURE worker (explicit paths, no prompting, no
 * daemon, no process.cwd()), so tests run it against a temp vault + temp index
 * and the real setup is never touched.
 *
 * Default clears only what the system can re-derive:
 *   - the SQLite index (rebuildable from the vault on the next daemon start).
 * It KEEPS the curated USER/MEMORY/PROJECT files and every file in the vault
 * (daily/, sessions/, digests/) — those ARE the vault the index re-derives from,
 * so deleting them would be data loss, not a reset.
 *
 * It used to also delete `vault/pending/` (the review queue). The queue was
 * removed on 2026-07-28, so nothing writes that folder any more. A vault set up
 * before that still holds the old files, and they are the user's data now:
 * reset leaves them alone, and deleting them stays the user's own decision.
 *
 * `--all` additionally empties the curated files (strips their entries, keeping
 * the headings and <!-- auto --> markers so the vault stays usable). That is the
 * only mode that touches curated memory, and the CLI gates it on a strong
 * confirmation.
 */

/** The curated file basenames a reset --all empties. */
const CURATED_BASENAMES = ['USER.md', 'MEMORY.md', 'PROJECT.md'];

export interface ResetOptions {
  /** SQLite index root to delete. */
  indexDir: string;
  /** Vault roots (name -> path); the curated files live under each. */
  vaults: MemoryConfig['vaults'];
  /** Also empty the curated files. Requires strong confirmation upstream. */
  all?: boolean | undefined;
}

export interface ResetRecord {
  label: string;
  path: string;
  existed: boolean;
}

export interface ResetResult {
  cleared: ResetRecord[];
  /** Curated files emptied (only when all=true). */
  curatedCleared: ResetRecord[];
  /** Curated files left intact (only when all=false). */
  curatedKept: Array<{ label: string; path: string }>;
}

/** Deletes a file or directory tree if present; reports whether it existed. */
function removePath(label: string, target: string): ResetRecord {
  const existed = fs.existsSync(target);
  if (existed) fs.rmSync(target, { recursive: true, force: true, maxRetries: 5 });
  return { label, path: target, existed };
}

/**
 * Removes every list-item line, keeping headings, comments and blank lines. This
 * empties the curated memory while leaving a valid, immediately-usable file.
 */
export function stripCuratedEntries(content: string): string {
  return content
    .split('\n')
    .filter((line) => !/^\s*[-*+]\s+/.test(line))
    .join('\n');
}

/** Clears state and returns the report. Order: curated (opt), then index. */
export function runReset(opts: ResetOptions): ResetResult {
  const cleared: ResetRecord[] = [];
  const curatedCleared: ResetRecord[] = [];
  const curatedKept: Array<{ label: string; path: string }> = [];

  // Curated files: emptied only with --all; otherwise reported as kept.
  for (const [name, root] of Object.entries(opts.vaults)) {
    for (const base of CURATED_BASENAMES) {
      const abs = path.join(root, base);
      if (!fs.existsSync(abs)) continue;
      if (opts.all) {
        const before = fs.readFileSync(abs, 'utf8');
        fs.writeFileSync(abs, stripCuratedEntries(before), 'utf8');
        curatedCleared.push({ label: `${base} (vault '${name}')`, path: abs, existed: true });
      } else {
        curatedKept.push({ label: `${base} (vault '${name}')`, path: abs });
      }
    }
  }

  // Index: rebuildable, so it goes last (the daemon recreates it on next boot).
  cleared.push(removePath('SQLite index', opts.indexDir));

  return { cleared, curatedCleared, curatedKept };
}

/** The real index root (honors MEMORY_INDEX_DIR). Tests pass an explicit dir. */
export function defaultResetIndexDir(): string {
  return process.env['MEMORY_INDEX_DIR'] ?? indexRootDir();
}
