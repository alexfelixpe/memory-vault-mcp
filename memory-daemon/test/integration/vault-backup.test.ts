import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import type Database from 'better-sqlite3';
import { openIndexDb } from '../../src/index/db.js';
import { runVaultBackup } from '../../src/daemon/backup/vault-backup.js';
import { makeTmpIndexDir } from '../helpers/tmp-vault.js';
import type { MemoryConfig } from '../../src/core/config.js';

/**
 * Finding #4 (security hardening): the daily vault auto-commit must never be the
 * thing that persists a secret. A file authored outside the write pipeline can
 * carry a secret into the vault; the commit step has to refuse it.
 */

const silent = pino({ level: 'silent' });

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

describe('vault backup secret guard (finding #4)', () => {
  let repoRoot: string;
  let vaultRoot: string;
  let index: ReturnType<typeof makeTmpIndexDir>;
  let db: Database.Database;
  let config: MemoryConfig;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memcommit-'));
    vaultRoot = path.join(repoRoot, 'vault');
    fs.mkdirSync(vaultRoot, { recursive: true });
    git(repoRoot, 'init', '-q');
    git(repoRoot, 'config', 'user.email', 'test@example.com');
    git(repoRoot, 'config', 'user.name', 'Test');
    git(repoRoot, 'config', 'commit.gpgsign', 'false');
    // An initial commit so HEAD exists, matching the real vault repo.
    fs.writeFileSync(path.join(vaultRoot, 'USER.md'), '# USER\n');
    git(repoRoot, 'add', 'vault');
    git(repoRoot, 'commit', '-q', '-m', 'init');

    index = makeTmpIndexDir();
    db = openIndexDb({ rootDir: index.root });
    config = { vaults: { global: vaultRoot }, defaultVault: 'global', embeddings: { enabled: false, model: 'x' } };
  });

  afterEach(() => {
    db.close();
    index.cleanup();
    fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5 });
  });

  it('refuses the auto-commit when a staged vault file contains a secret', async () => {
    fs.writeFileSync(path.join(vaultRoot, 'leak.md'), '# Leak\n\nkey sk-ant-api03-ZZTESTSECRET1234567890 here\n');
    const head = git(repoRoot, 'rev-parse', 'HEAD');

    const res = await runVaultBackup(db, config, silent);

    expect(res.committed).toBe(false);
    expect(res.secretBlocked).toContain('vault/leak.md');
    // No new commit was created: the secret never entered Git history.
    expect(git(repoRoot, 'rev-parse', 'HEAD')).toBe(head);
    // The secret file was not left staged in the Git index either.
    expect(git(repoRoot, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('commits normally when no staged vault file contains a secret', async () => {
    fs.writeFileSync(path.join(vaultRoot, 'clean.md'), '# Clean\n\njust a normal note with no secret\n');
    const head = git(repoRoot, 'rev-parse', 'HEAD');

    const res = await runVaultBackup(db, config, silent);

    expect(res.secretBlocked).toEqual([]);
    expect(res.committed).toBe(true);
    expect(git(repoRoot, 'rev-parse', 'HEAD')).not.toBe(head);
  });

  // The weekly digest was built from the review queue rows. The queue is gone,
  // so the job must not create a digests/ folder out of nothing.
  it('writes no digest: the weekly digest went away with the review queue', async () => {
    fs.writeFileSync(path.join(vaultRoot, 'clean.md'), '# Clean\n\njust a normal note\n');

    await runVaultBackup(db, config, silent);

    expect(fs.existsSync(path.join(vaultRoot, 'digests'))).toBe(false);
  });
});
