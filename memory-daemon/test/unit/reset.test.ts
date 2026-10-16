import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runReset, stripCuratedEntries } from '../../src/cli/reset.js';

/**
 * `memory reset` clears the rebuildable index and keeps everything in the vault.
 * Every case is hermetic: a temp vault + a temp index dir, never the real setup.
 */

let tmp: string;
let vaultRoot: string;
let indexDir: string;

const USER = '# USER\n\n## Profile\n\n- Alice, staff engineer\n\n## Preferences <!-- auto -->\n\n- Short answers\n';
const MEMORY = '# MEMORY\n\n## Notes <!-- auto -->\n\n- zephyrmauve is the dashboard color\n';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-reset-'));
  vaultRoot = path.join(tmp, 'vault');
  indexDir = path.join(tmp, 'index');
  fs.mkdirSync(vaultRoot, { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, 'USER.md'), USER, 'utf8');
  fs.writeFileSync(path.join(vaultRoot, 'MEMORY.md'), MEMORY, 'utf8');
  // Leftovers from the removed review queue: a vault set up before 2026-07-28
  // still has this folder, and reset must not delete the user's files.
  fs.mkdirSync(path.join(vaultRoot, 'pending'), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, 'pending', 'queue.jsonl'), '{"event":"proposed","id":"x"}\n', 'utf8');
  fs.writeFileSync(path.join(vaultRoot, 'pending', 'INBOX.md'), '# INBOX\n', 'utf8');
  fs.mkdirSync(path.join(indexDir, 'gen-000001'), { recursive: true });
  fs.writeFileSync(path.join(indexDir, 'CURRENT'), 'gen-000001\n', 'utf8');
  // A daily note (reservoir) that a plain reset must NOT delete.
  fs.mkdirSync(path.join(vaultRoot, 'daily'), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, 'daily', '2026-07-25.md'), '# 2026-07-25\n\n- worked on X\n', 'utf8');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

describe('runReset (default)', () => {
  it('clears the index but keeps curated files, vault notes and old queue leftovers', () => {
    const res = runReset({ indexDir, vaults: { global: vaultRoot } });

    // Only the rebuildable index is gone.
    expect(fs.existsSync(indexDir)).toBe(false);

    // Curated files are untouched (still hold their entries).
    expect(fs.readFileSync(path.join(vaultRoot, 'USER.md'), 'utf8')).toContain('Alice, staff engineer');
    expect(fs.readFileSync(path.join(vaultRoot, 'MEMORY.md'), 'utf8')).toContain('zephyrmauve');

    // Vault notes (the reservoir source the index re-derives from) are kept.
    expect(fs.existsSync(path.join(vaultRoot, 'daily', '2026-07-25.md'))).toBe(true);

    // The removed queue's leftover files are the user's data now. Deleting them
    // is their decision, so reset leaves them exactly where they are.
    expect(fs.existsSync(path.join(vaultRoot, 'pending', 'queue.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(vaultRoot, 'pending', 'INBOX.md'))).toBe(true);

    // The report names what was cleared and what was kept.
    expect(res.cleared.some((r) => r.label.includes('index') && r.existed)).toBe(true);
    expect(res.cleared.some((r) => r.label.includes('pending'))).toBe(false);
    expect(res.curatedKept.map((k) => path.basename(k.path)).sort()).toEqual(['MEMORY.md', 'USER.md']);
    expect(res.curatedCleared).toHaveLength(0);
  });
});

describe('runReset (--all)', () => {
  it('also empties the curated files, keeping their headings and auto markers', () => {
    const res = runReset({ indexDir, vaults: { global: vaultRoot }, all: true });

    const user = fs.readFileSync(path.join(vaultRoot, 'USER.md'), 'utf8');
    const memory = fs.readFileSync(path.join(vaultRoot, 'MEMORY.md'), 'utf8');

    // The entries are gone...
    expect(user).not.toContain('Alice, staff engineer');
    expect(memory).not.toContain('zephyrmauve');
    // ...but the structure stays usable (headings + the <!-- auto --> marker).
    expect(user).toContain('## Preferences <!-- auto -->');
    expect(memory).toContain('## Notes <!-- auto -->');

    expect(res.curatedCleared.map((c) => path.basename(c.path)).sort()).toEqual(['MEMORY.md', 'USER.md']);
    expect(res.curatedKept).toHaveLength(0);
  });
});

describe('stripCuratedEntries', () => {
  it('removes list items and keeps everything else', () => {
    const out = stripCuratedEntries('# H\n\n## S <!-- auto -->\n\n- one\n- two\ntext line\n');
    expect(out).not.toContain('- one');
    expect(out).not.toContain('- two');
    expect(out).toContain('## S <!-- auto -->');
    expect(out).toContain('text line');
  });
});
