import fs from 'node:fs';
import path from 'node:path';

/**
 * Durable, append-only write log. The human audit trail — "who/what wrote what,
 * when" that `memory log` shows — must OUTLIVE `memory reset` and
 * `memory uninstall`, both of which wipe or rebuild the SQLite index. So the
 * truth lives here: a JSONL file inside the vault's own `.memory/` folder, next
 * to the backups. That folder is skipped by the indexer, ignored by the
 * watcher, never touched by reset, and kept by uninstall unless the whole vault
 * is purged on purpose. The SQLite index keeps a copy only as a fast
 * projection; this file is the source of truth.
 */

/** One recorded write. Field names mirror the SQLite `write_log` columns. */
export interface WriteLogEntry {
  ts: number;
  vault: string;
  path: string;
  op: string;
  section?: string | null | undefined;
  before_hash?: string | null | undefined;
  after_hash?: string | null | undefined;
  backup_path?: string | null | undefined;
  actor: string;
  /**
   * Claimed provenance of the write (the op `source`: `user` | `inferred` |
   * `third_party`, comma-joined for a batch; null for daily/purge). Audit/
   * display only — it is NEVER a security signal. It exists so the trail can
   * show that a line was written claiming source:'user'; the injection scan and
   * auto-section gate key on `actor`, not this. Absent on log lines written
   * before this field existed (old lines stay readable).
   */
  source?: string | null | undefined;
  session_id?: string | null | undefined;
  /**
   * Which connected app performed the write (from the MCP `clientInfo.name`
   * handshake). Display/audit only; absent for CLI or internal writes. It is
   * NEVER consulted in any security decision (see the auto-section gate, which
   * keys on the server-set `actor`, not this label).
   */
  client?: string | null | undefined;
}

/** Absolute path of a vault's durable write log (beside `.memory/backups/`). */
export function writeLogPath(vaultRoot: string): string {
  return path.join(vaultRoot, '.memory', 'write-log.jsonl');
}

/**
 * Cleans an app-declared client name before it is stored. The name arrives from
 * the connecting app over MCP, so it is untrusted text: keep a single line,
 * drop control characters, and cap the length. It is a display label only and
 * is never used to make a trust or authorization decision.
 */
export function sanitizeClientName(name: string | null | undefined): string | undefined {
  if (typeof name !== 'string') return undefined;
  // Replace ASCII control characters (0x00-0x1f and 0x7f), including newlines,
  // with a space so the label cannot forge a second log line or break the JSONL.
  let clean = '';
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    clean += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  clean = clean.trim().slice(0, 40);
  return clean.length > 0 ? clean : undefined;
}

/**
 * Appends one entry as a single JSON line, then fsyncs so a power loss cannot
 * lose or tear the record. Called only by the daemon (the single writer), whose
 * per-file serial queue already orders the writes, so this append never races
 * itself within the process.
 */
export function appendWriteLog(vaultRoot: string, entry: WriteLogEntry): void {
  const file = writeLogPath(vaultRoot);
  // A brand-new vault may not have the `.memory/` folder yet.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  // Append mode + fsync: an audit record must survive a crash, the same
  // durability discipline the atomic markdown writer uses for content.
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Reads the durable log across the given vault roots, newest first, capped at
 * `limit`. A missing file is skipped and a single unparseable line is ignored,
 * so one torn record can never hide the whole history or throw.
 */
export function readWriteLog(vaultRoots: string[], limit: number): WriteLogEntry[] {
  const all: WriteLogEntry[] = [];
  for (const root of vaultRoots) {
    const file = writeLogPath(root);
    if (!fs.existsSync(file)) continue;
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // an unreadable file for one vault never breaks the others
    }
    for (const rawLine of raw.split('\n')) {
      if (!rawLine.trim()) continue;
      try {
        const entry = JSON.parse(rawLine) as WriteLogEntry;
        if (typeof entry.ts === 'number') all.push(entry);
      } catch {
        // A single corrupt line is skipped, never fatal.
      }
    }
  }
  // Newest first; ties keep read order (fine for writes in the same millisecond).
  all.sort((a, b) => b.ts - a.ts);
  return all.slice(0, limit);
}
