import crypto from 'node:crypto';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { Origin } from '../../core/provenance.js';

/**
 * Reader for Claude Code's JSONL transcript. The format is NOT a public
 * contract: the parser ignores an unknown line by requirement. The watermark
 * by (session_id, byte_offset) only advances AFTER the pass persists; the hash
 * of the first 4096 bytes detects a file swap/rotation. The ORIGIN is stamped
 * here, deterministically — never by the model (critique A10): a user turn
 * becomes session_extract; a tool_result becomes third_party_derived.
 */

export interface DeltaTurn {
  n: number;
  role: 'user' | 'assistant' | 'tool_result';
  origin: Origin;
  text: string;
  uuid: string | undefined;
}

export interface Delta {
  turns: DeltaTurn[];
  newByteOffset: number;
  headSha256: string;
}

const MAX_DELTA_CHARS = 96_000; // ~24k tokens

function headHash(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    return crypto.createHash('sha256').update(buf.subarray(0, n)).digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

/** Extracts readable text from a content that may be a string or blocks. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as { type?: string; text?: string; content?: unknown };
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        if (block.type === 'tool_result') return contentText(block.content);
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function readDelta(db: Database.Database, sessionId: string, transcriptPath: string): Delta {
  const wm = db.prepare('SELECT transcript_path, head_sha256, byte_offset FROM capture_watermark WHERE session_id = ?')
    .get(sessionId) as { transcript_path: string; head_sha256: string; byte_offset: number } | undefined;

  const head = headHash(transcriptPath);
  // File swapped (rotation, resume into a new file): restart from zero;
  // the uuid dedup in seen_message prevents reprocessing an old message.
  let offset = wm && wm.head_sha256 === head && wm.transcript_path === transcriptPath ? wm.byte_offset : 0;
  const size = fs.statSync(transcriptPath).size;
  if (offset > size) offset = 0;

  const fd = fs.openSync(transcriptPath, 'r');
  let raw: string;
  try {
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    raw = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  // Only consume up to the last complete line: a half line waits for the next pass.
  const lastNl = raw.lastIndexOf('\n');
  const consumed = lastNl === -1 ? 0 : lastNl + 1;
  const newByteOffset = offset + Buffer.byteLength(raw.slice(0, consumed), 'utf8');

  const seen = db.prepare('SELECT 1 FROM seen_message WHERE session_id = ? AND uuid = ?');
  const turns: DeltaTurn[] = [];
  let n = 0;
  let chars = 0;

  for (const line of raw.slice(0, consumed).split('\n')) {
    if (line.trim() === '') continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // unknown/corrupted line: the requirement is to ignore it
    }
    const uuid = typeof obj['uuid'] === 'string' ? obj['uuid'] : undefined;
    if (uuid && seen.get(sessionId, uuid)) continue;
    if (obj['isSidechain'] === true) continue;

    const type = obj['type'];
    const message = obj['message'] as { role?: string; content?: unknown } | undefined;
    if ((type !== 'user' && type !== 'assistant') || !message) continue;

    const text = contentText(message.content).trim();
    if (text === '') continue;

    // tool_result inside a user turn = tool output, NOT the user speaking.
    const isToolResult = Array.isArray(message.content)
      && (message.content as Array<{ type?: string }>).every((b) => b.type === 'tool_result');
    const role: DeltaTurn['role'] = type === 'assistant' ? 'assistant' : isToolResult ? 'tool_result' : 'user';
    const origin: Origin = role === 'user' ? 'session_extract' : 'third_party_derived';

    if (chars + text.length > MAX_DELTA_CHARS) break;
    chars += text.length;
    turns.push({ n: n++, role, origin, text: text.slice(0, 8000), uuid });
  }

  return { turns, newByteOffset, headSha256: head };
}

/** Persists the watermark ONLY after the pass writes its results. */
export function commitWatermark(
  db: Database.Database,
  sessionId: string,
  transcriptPath: string,
  delta: Delta,
): void {
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO capture_watermark (session_id, transcript_path, head_sha256, byte_offset, turns_since_pass, last_pass_at, status)
      VALUES (?, ?, ?, ?, 0, ?, 'idle')
      ON CONFLICT(session_id) DO UPDATE SET
        transcript_path = excluded.transcript_path, head_sha256 = excluded.head_sha256,
        byte_offset = excluded.byte_offset, turns_since_pass = 0,
        last_pass_at = excluded.last_pass_at, status = 'idle'
    `).run(sessionId, transcriptPath, delta.headSha256, delta.newByteOffset, new Date().toISOString());
    const ins = db.prepare('INSERT OR IGNORE INTO seen_message (session_id, uuid) VALUES (?, ?)');
    for (const t of delta.turns) if (t.uuid) ins.run(sessionId, t.uuid);
  });
  tx();
}
