import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type pino from 'pino';
import type { MemoryConfig } from '../../core/config.js';
import { scanSecrets } from '../../security/scan-secrets.js';

/**
 * Vault backup job: commits the vault to its local git once a day, never pushes;
 * refuses the commit when a staged file contains a secret.
 *
 * The review queue was removed on 2026-07-28 (owner's decision), and with it the
 * three parts of this job that only served it: the 7-day expiry of open items,
 * the weekly digest (it was built from the queue rows, so it has no source any
 * more) and the queue-size alarm. A captured item is now either written straight
 * to memory or discarded, so there is nothing left to age out or summarize.
 *
 * Timer + last_run_at marker: the machine hibernates and the timer misses its
 * trigger, the marker guarantees the resumption.
 */

export interface VaultBackupResult {
  committed: boolean;
  /**
   * Finding #4: staged vault files that tripped the secret scan. When non-empty
   * the auto-commit was refused so a secret never enters local Git history.
   */
  secretBlocked: string[];
}

export async function runVaultBackup(
  db: Database.Database,
  config: MemoryConfig,
  log: pino.Logger,
): Promise<VaultBackupResult> {
  const vaultRoot = config.vaults['global']!;
  const result: VaultBackupResult = { committed: false, secretBlocked: [] };

  // Local commit of the global vault (no push): history is the undo of everything.
  // The vault may be its OWN git repository (2026-07-29, owner's decision: the
  // memory must never ride to a remote with the code repo). When vault/.git
  // exists, commit there; otherwise fall back to the old layout, the vault as a
  // folder of the surrounding repo.
  try {
    const ownRepo = fs.existsSync(path.join(vaultRoot, '.git'));
    const repoRoot = ownRepo ? vaultRoot : path.resolve(vaultRoot, '..');
    const pathspec = ownRepo ? '.' : 'vault';
    const opts = { timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
    execFileSync('git', ['-C', repoRoot, 'add', pathspec], opts);
    const diff = execFileSync('git', ['-C', repoRoot, 'diff', '--cached', '--name-only', '--', pathspec], { ...opts, encoding: 'utf8' as const }).trim();
    if (diff) {
      // Finding #4: the commit must never be the thing that persists a secret.
      // Scan every staged vault file; on any hit, refuse the whole commit and
      // unstage so nothing sensitive sits in the Git index either.
      const staged = diff.split('\n').map((s) => s.trim()).filter(Boolean);
      const flagged: string[] = [];
      for (const rel of staged) {
        const abs = path.resolve(repoRoot, rel);
        // A staged deletion has no file to read and cannot leak a secret.
        if (!fs.existsSync(abs)) continue;
        if (scanSecrets(fs.readFileSync(abs, 'utf8')).length > 0) flagged.push(rel);
      }
      if (flagged.length > 0) {
        result.secretBlocked = flagged;
        log.warn({ files: flagged }, 'vault auto-commit refused: a staged file contains a secret');
        // Best-effort unstage; on an unborn branch (no HEAD) there is nothing to reset.
        try { execFileSync('git', ['-C', repoRoot, 'reset', '-q', '--', pathspec], opts); } catch { /* no HEAD yet */ }
      } else {
        execFileSync('git', ['-C', repoRoot, 'commit', '-q', '-m', `chore(vault): automatic backup ${new Date().toISOString().slice(0, 10)}`], opts);
        result.committed = true;
      }
    }
  } catch (e) {
    log.warn(e, 'automatic vault commit failed (continuing without it)');
  }

  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('backup_last_run_at', ?)").run(String(Date.now()));
  log.info(result, 'vault backup ran');
  return result;
}

/** Returns true if the job should run (never ran or passed 24 h). */
export function vaultBackupDue(db: Database.Database): boolean {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'backup_last_run_at'").get() as { value: string } | undefined;
  return !row || Date.now() - Number(row.value) > 24 * 3_600_000;
}
