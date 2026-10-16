import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Atomic write on Windows (section 7 of the plan): tmp in the SAME
 * directory, fsync, rename with retry and jitter (the Defender scan holds
 * handles). A .bak backup before every mutation, retention of the last 20
 * versions.
 */

const RENAME_RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const BACKUP_RETENTION = 20;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class WriteBlockedByPolicyError extends Error {
  readonly code = 'WRITE_BLOCKED_BY_POLICY';
  constructor(target: string) {
    super(`Persistent EACCES while writing ${target}. Windows Controlled Folder Access? ` +
      'Add node.exe to the allowed apps or the vault to the exclusions.');
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  let delay = 12;
  for (let attempt = 0; attempt < 12; attempt++) {   // total window ~3.5s
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!RENAME_RETRYABLE.has(code) || attempt === 11) {
        fs.rmSync(from, { force: true });
        if (code === 'EACCES' || code === 'EPERM') throw new WriteBlockedByPolicyError(to);
        throw e;
      }
      await sleep(delay + Math.random() * delay);    // jitter against Defender
      delay = Math.min(delay * 1.8, 500);
    }
  }
}

export async function atomicWriteMarkdown(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  // Extension not ending in .md: Obsidian ignores it and creates no ghost note.
  const tmp = path.join(dir, `.${base}.pm-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const fd = fs.openSync(tmp, 'wx', 0o666);          // 'wx' never reuses a tmp
  try {
    const buf = Buffer.from(content, 'utf8');
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);                                // without this, a power loss leaves a file of zeros
  } finally {
    fs.closeSync(fd);
  }
  await renameWithRetry(tmp, targetPath);
  // There is no directory fsync on Windows; the entry's durability is
  // handled by the NTFS journal.
}

/**
 * Copies the current file to <vault>/.memory/backups/<relpath>.<epochms>.bak
 * before the mutation. Returns the backup path (or undefined if there was no
 * file). Keeps the last 20 versions per file.
 */
export function backupBeforeWrite(vaultRoot: string, relPath: string): string | undefined {
  const source = path.join(vaultRoot, relPath);
  if (!fs.existsSync(source)) return undefined;
  const backupDir = path.join(vaultRoot, '.memory', 'backups', path.dirname(relPath));
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${path.basename(relPath)}.${Date.now()}.bak`);
  fs.copyFileSync(source, backupPath);

  const prefix = `${path.basename(relPath)}.`;
  const siblings = fs.readdirSync(backupDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.bak'))
    .sort();
  for (const old of siblings.slice(0, Math.max(0, siblings.length - BACKUP_RETENTION))) {
    fs.rmSync(path.join(backupDir, old), { force: true });
  }
  return backupPath;
}
