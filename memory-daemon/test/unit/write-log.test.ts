import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendWriteLog, readWriteLog, writeLogPath, sanitizeClientName, type WriteLogEntry,
} from '../../src/core/write-log.js';

/**
 * The durable write log: the audit trail must live under the vault's .memory/,
 * survive being read back, and never let a hostile client name break the file.
 * These are pure-fs unit tests against a temp vault.
 */

let root: string;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-wlog-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

const entry = (over: Partial<WriteLogEntry>): WriteLogEntry => ({
  ts: 1, vault: 'global', path: 'MEMORY.md', op: 'add', actor: 'user_cli', ...over,
});

describe('durable write log (append / read)', () => {
  it('writes the JSONL beside .memory/ and reads entries back newest-first', () => {
    appendWriteLog(root, entry({ ts: 100, actor: 'user_cli' }));
    appendWriteLog(root, entry({ ts: 200, actor: 'memory_add', client: 'Claude Code' }));

    // Lives under the vault's own .memory/ folder (not the index).
    expect(fs.existsSync(writeLogPath(root))).toBe(true);
    expect(writeLogPath(root)).toContain(path.join('.memory', 'write-log.jsonl'));

    const rows = readWriteLog([root], 20);
    expect(rows.map((r) => r.ts)).toEqual([200, 100]); // newest first
    expect(rows[0]?.client).toBe('Claude Code');
  });

  it('honors the limit and merges multiple vault roots', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-wlog2-'));
    try {
      appendWriteLog(root, entry({ ts: 10, vault: 'global' }));
      appendWriteLog(other, entry({ ts: 20, vault: 'work' }));
      appendWriteLog(other, entry({ ts: 30, vault: 'work' }));
      const rows = readWriteLog([root, other], 2);
      expect(rows.map((r) => r.ts)).toEqual([30, 20]); // limit applied after merge
    } finally {
      fs.rmSync(other, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('skips a corrupt line instead of throwing, and returns [] for a missing file', () => {
    expect(readWriteLog([root], 20)).toEqual([]); // no file yet
    appendWriteLog(root, entry({ ts: 5 }));
    fs.appendFileSync(writeLogPath(root), 'this is not json\n');
    appendWriteLog(root, entry({ ts: 6 }));
    const rows = readWriteLog([root], 20);
    expect(rows.map((r) => r.ts)).toEqual([6, 5]); // the bad line is skipped
  });
});

describe('sanitizeClientName (untrusted display label)', () => {
  it('keeps a normal app name', () => {
    expect(sanitizeClientName('Claude Desktop')).toBe('Claude Desktop');
  });

  it('returns undefined for a non-string or empty/whitespace name', () => {
    expect(sanitizeClientName(undefined)).toBeUndefined();
    expect(sanitizeClientName(null)).toBeUndefined();
    expect(sanitizeClientName('   ')).toBeUndefined();
  });

  it('neutralizes newlines and control chars so a name cannot forge a log line', () => {
    // A hostile name trying to inject a second record collapses to one clean line.
    const evil = 'Claude\n{"ts":0,"op":"forged"}';
    const clean = sanitizeClientName(evil)!;
    expect(clean).not.toContain('\n');
    expect(clean.startsWith('Claude')).toBe(true);
  });

  it('caps the length at 40 characters', () => {
    expect(sanitizeClientName('x'.repeat(100))!.length).toBe(40);
  });
});
