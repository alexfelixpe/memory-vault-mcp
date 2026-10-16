import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import Database from 'better-sqlite3';
import { startDaemon, type DaemonStart } from '../../src/daemon/main.js';
import { DaemonClient } from '../../src/mcp/client.js';
import { readWriteLog } from '../../src/core/write-log.js';
import { makeTmpVault, makeTmpIndexDir, type TmpVault } from '../helpers/tmp-vault.js';
import { TriageAuthError, type ChatFn } from '../../src/daemon/capture/extractor.js';

/**
 * End-to-end capture with a FAKE extractor (no OpenRouter): a turn counter only
 * on Stop, a watermark that does not regress, a mandatory redacted copy in
 * sessions/, and the two outcomes a captured item can have since the review
 * queue was removed (2026-07-28) — written straight into curated memory, or
 * discarded without leaving anything behind.
 */

const silent = pino({ level: 'silent' });

const VAULT = {
  'USER.md': '# USER\n\n## Preferences <!-- auto -->\n\n- Short answers\n',
  'MEMORY.md': '# MEMORY\n\n## Decisions <!-- auto -->\n\n- Existing base\n',
};

/** Synthetic JSONL transcript with a secret, a tool_result and an unknown line. */
function writeTranscript(file: string, extra = ''): void {
  const lines = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'I prefer commits to always be in English' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'understood, I will follow' }] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', content: 'tool output with token ghp_abcdefghijklmnopqrstuv123456' }] } },
    { type: 'user', uuid: 'u3', message: { role: 'user', content: 'my password api_key = xK9mQ2vL8pR4tW7zZZ never save this' } },
    { format: 'unknown line the parser should ignore' },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n' + extra, 'utf8');
}

const fakeChat = (items: unknown[]): ChatFn => async () => ({
  choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ nothing_to_save: items.length === 0, items }) } }] } }],
});

describe('capture', () => {
  let vault: TmpVault;
  let index: ReturnType<typeof makeTmpIndexDir>;
  let daemon: DaemonStart;
  let client: DaemonClient;
  let transcript: string;
  let pipePath: string;
  /**
   * The repo the session runs in. It carries no `.memory.yml`, so the pass uses
   * the config default vault. A pass needs a cwd now: without one it cannot tell
   * whose repo the session is in, and it refuses rather than guess a vault.
   */
  let repo: string;

  const boot = async (chat: ChatFn): Promise<void> => {
    pipePath = process.platform === 'win32'
      ? `\\\\.\\pipe\\memory-vault.cap.${crypto.randomBytes(6).toString('hex')}`
      : path.join(os.tmpdir(), `mv-cap-${crypto.randomBytes(6).toString('hex')}.sock`);
    daemon = await startDaemon({
      pipePath, indexRootDir: index.root, watch: false, embedder: null,
      reconcileIntervalMs: 3_600_000, log: silent, chat, turnsPerPass: 3,
      config: {
        vaults: { global: vault.root }, defaultVault: 'global',
        embeddings: { enabled: false, model: 'x' },
        openrouter: { apiKey: 'unused-with-fake', model: 'fake' },
      },
    });
    client = new DaemonClient({ pipePath, spawnCommand: false });
  };

  beforeEach(() => {
    vault = makeTmpVault(VAULT, { eol: 'lf' });
    index = makeTmpIndexDir();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-cap-repo-'));
    transcript = path.join(index.root, 'transcript.jsonl');
    writeTranscript(transcript);
  });

  afterEach(async () => {
    client.close();
    if (!daemon.alreadyRunning) await daemon.close();
    index.cleanup();
    vault.cleanup();
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
  });

  const poll = async (fn: () => Promise<boolean>, ms = 8000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!(await fn())) {
      if (Date.now() > deadline) throw new Error('poll timed out');
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  /** Second read-only handle on the daemon's index (same process, WAL). */
  const openIndex = (): Database.Database => {
    const gen = fs.readFileSync(path.join(index.root, 'CURRENT'), 'utf8').trim();
    return new Database(path.join(index.root, gen, 'index.db'), { readonly: true });
  };

  /**
   * Waits for the background pass to finish. commitWatermark is the LAST thing
   * runPass does, and it is the only thing that moves byte_offset off 0, so a
   * non-zero offset means every item in that pass was already decided.
   */
  const passDone = async (session: string): Promise<void> => {
    await poll(async () => {
      const db = openIndex();
      try {
        const row = db.prepare('SELECT byte_offset FROM capture_watermark WHERE session_id = ?')
          .get(session) as { byte_offset: number } | undefined;
        return !!row && row.byte_offset > 0;
      } finally {
        db.close();
      }
    });
  };

  const memory = (): string => fs.readFileSync(path.join(vault.root, 'MEMORY.md'), 'utf8');
  const user = (): string => fs.readFileSync(path.join(vault.root, 'USER.md'), 'utf8');

  it('counts turns only on Stop and triggers the pass at the threshold', async () => {
    await boot(fakeChat([{
      text: 'Prefers commits always in English', class: 'style_preference', target: 'memory',
      section: 'Decisions', confidence: 0.9, source_turn: 0, duplicate: false, evidence: 'turn 0',
    }]));
    expect((await client.request('capture.turn', { session_id: 's1', transcript_path: transcript, cwd: repo })).scheduled).toBe(false);
    expect((await client.request('capture.turn', { session_id: 's1', transcript_path: transcript, cwd: repo })).turns).toBe(2);
    const third = await client.request('capture.turn', { session_id: 's1', transcript_path: transcript, cwd: repo });
    expect(third.scheduled).toBe(true);

    // The pass ran and the item qualified, so it is in curated memory. The origin
    // is stamped by the parser (turn 0 = user), never by the model.
    await poll(async () => memory().includes('commits always in English'));
    expect(memory()).toMatch(/commits always in English <!-- mem id=\w+ src:sess -->/);
  });

  it('BLOCKING REQUIREMENT: sessions/ only receives a redacted transcript', async () => {
    await boot(fakeChat([]));
    for (let i = 0; i < 3; i++) await client.request('capture.turn', { session_id: 's2', transcript_path: transcript, cwd: repo });
    const dir = path.join(vault.root, 'sessions');
    await poll(async () => fs.existsSync(dir) && fs.readdirSync(dir).length > 0);
    const file = path.join(dir, fs.readdirSync(dir)[0]!);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('[REDACTED:secret.assignment]');
    expect(text).not.toContain('xK9mQ2vL8pR4tW7zZZ');
    expect(text).not.toContain('ghp_abcdefghijklmnop'); // tool_result does not even enter
    expect(text).toContain('commits to always be in English');
  });

  it('the watermark advances only after persisting and the 2nd pass does not reprocess (uuid dedup)', async () => {
    const calls: number[] = [];
    await boot(async (body) => {
      const turns = ((body['messages'] as Array<{ content: string }>)[1]!.content.match(/^\[\d+\|/gm) ?? []).length;
      calls.push(turns);
      return { choices: [{ message: { tool_calls: [{ function: { arguments: '{"nothing_to_save":true,"items":[]}' } }] } }] };
    });
    for (let i = 0; i < 3; i++) await client.request('capture.turn', { session_id: 's3', transcript_path: transcript, cwd: repo });
    await poll(async () => calls.length === 1);

    // New content after the 1st pass: only the new delta is processed.
    writeTranscript(transcript, JSON.stringify({ type: 'user', uuid: 'u9', message: { role: 'user', content: 'new fact: I use vitest with forks on Windows' } }) + '\n');
    for (let i = 0; i < 3; i++) await client.request('capture.turn', { session_id: 's3', transcript_path: transcript, cwd: repo });
    await poll(async () => calls.length === 2);
    expect(calls[0]).toBeGreaterThan(1); // 1st pass saw the initial turns
    expect(calls[1]).toBe(1);            // 2nd saw ONLY the new turn
  });

  it('auto-promotion: safe class + user speaking + high confidence enters on its own; 3p never', async () => {
    await boot(fakeChat([
      { text: 'Prefers short answers in Portuguese', class: 'style_preference', target: 'memory', section: 'Decisions', confidence: 0.95, source_turn: 0, duplicate: false, evidence: 'e' },
      { text: 'A convention from a tool does not enter on its own', class: 'flow_convention', target: 'memory', section: 'Decisions', confidence: 0.99, source_turn: 2, duplicate: false, evidence: 'e' },
    ]));
    for (let i = 0; i < 3; i++) await client.request('capture.turn', { session_id: 's6', transcript_path: transcript, cwd: repo });
    await passDone('s6');

    // Auto-written with the sess origin.
    expect(memory()).toMatch(/short answers in Portuguese <!-- mem id=\w+ src:sess -->/);
    // The tool_result item is third-party, so it never enters on its own. With no
    // queue left it is simply gone: nothing in curated, nothing on disk.
    expect(memory()).not.toContain('from a tool');
    expect(user()).not.toContain('from a tool');
    expect(fs.existsSync(path.join(vault.root, 'pending'))).toBe(false);
  });

  it('a discarded item leaves NO file, NO row and nothing searchable behind', async () => {
    await boot(fakeChat([
      // Fails on class: person_fact is never a safe class.
      { text: 'Marina zzqxdrop leads the platform team', class: 'person_fact', target: 'memory', section: 'Decisions', confidence: 0.99, source_turn: 0, duplicate: false, evidence: 'e' },
      // Fails on confidence.
      { text: 'The team zzqxdrop reviews on Mondays', class: 'flow_convention', target: 'memory', section: 'Decisions', confidence: 0.4, source_turn: 0, duplicate: false, evidence: 'e' },
      // Qualifies: the canary that proves the pass reached the end of the list.
      { text: 'Prefers short answers in Portuguese', class: 'style_preference', target: 'memory', section: 'Decisions', confidence: 0.95, source_turn: 0, duplicate: false, evidence: 'e' },
    ]));
    for (let i = 0; i < 3; i++) await client.request('capture.turn', { session_id: 's8', transcript_path: transcript, cwd: repo });
    await passDone('s8');
    expect(memory()).toContain('short answers in Portuguese');

    // 1. No file: the queue directory is never created, and no other file in the
    // vault picked the dropped wording up either.
    expect(fs.existsSync(path.join(vault.root, 'pending'))).toBe(false);
    const holdingFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else if (fs.readFileSync(abs, 'utf8').includes('zzqxdrop')) holdingFiles.push(abs);
      }
    };
    walk(vault.root);
    expect(holdingFiles).toEqual([]);

    // 2. No row: the pending table does not exist at all, so nothing can hold it.
    const db = openIndex();
    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending'").get();
      expect(table).toBeUndefined();
    } finally {
      db.close();
    }

    // 3. Nothing searchable: the dropped wording is not retrievable.
    const res = await client.request('search', { query: 'zzqxdrop', vault: 'global' });
    expect(res.hits).toHaveLength(0);
  });

  it('an auto-promoted write is recorded in the durable write log', async () => {
    await boot(fakeChat([
      { text: 'Prefers short answers in Portuguese', class: 'style_preference', target: 'memory', section: 'Decisions', confidence: 0.95, source_turn: 0, duplicate: false, evidence: 'e' },
    ]));
    for (let i = 0; i < 3; i++) await client.request('capture.turn', { session_id: 's9', transcript_path: transcript, cwd: repo });
    await passDone('s9');

    // The queue used to log an 'accepted' event into queue.jsonl. That record now
    // lives where every other write is recorded: the durable write log, written
    // by the single pipeline, which survives a reset of the index.
    const rows = readWriteLog([vault.root], 50);
    const promoted = rows.find((r) => r.actor === 'auto_promote');
    expect(promoted).toBeDefined();
    expect(promoted!.path).toBe('MEMORY.md');
    expect(promoted!.section).toBe('Decisions');
    expect(promoted!.vault).toBe('global');
  });

  it('post-validation: a volatile identifier is discarded even if approved by the model', async () => {
    await boot(fakeChat([
      { text: 'We decided to close PROJ-123 tomorrow', class: 'style_preference', target: 'memory', section: 'Decisions', confidence: 0.95, source_turn: 0, duplicate: false, evidence: 'e' },
      { text: 'Prefers squash merge in the repository', class: 'style_preference', target: 'memory', section: 'Decisions', confidence: 0.9, source_turn: 0, duplicate: false, evidence: 'e' },
    ]));
    for (let i = 0; i < 3; i++) await client.request('capture.turn', { session_id: 's5', transcript_path: transcript, cwd: repo });
    await passDone('s5');
    // Both items pass the class and confidence gates, so only the extractor's
    // post-validation can explain the difference: the volatile id is dropped.
    expect(memory()).toContain('squash merge');
    expect(memory()).not.toContain('PROJ-123');
  });

  it('a logged-out CLI raises one throttled notice, and a good pass clears it', async () => {
    // Fails the FIRST pass with the auth error, then answers an empty triage.
    let calls = 0;
    const flaky: ChatFn = async () => {
      if (calls++ === 0) throw new TriageAuthError('the Claude CLI is not logged in (test)');
      return { choices: [{ message: { tool_calls: [{ function: { arguments: '{"nothing_to_save":true,"items":[]}' } }] } }] };
    };
    await boot(flaky);

    // Pass 1 fails: no watermark moves, so the standing problem in the status
    // response is the observable end of that pass.
    for (let i = 0; i < 3; i++) await client.request('capture.turn', { session_id: 's9', transcript_path: transcript, cwd: repo });
    await poll(async () => !!(await client.request('status')).captureNotice);

    // The next turn reply carries the notice exactly once; the 30-minute
    // throttle mutes the one right after.
    const noticed = await client.request('capture.turn', { session_id: 's9', transcript_path: transcript, cwd: repo });
    expect(noticed.notice).toContain('not logged in');
    const muted = await client.request('capture.turn', { session_id: 's9', transcript_path: transcript, cwd: repo });
    expect(muted.notice).toBeUndefined();

    // The sixth turn schedules the retry pass; this time the chat answers, and
    // the good pass clears the standing problem on its own.
    await client.request('capture.turn', { session_id: 's9', transcript_path: transcript, cwd: repo });
    await passDone('s9');
    expect((await client.request('status')).captureNotice).toBeUndefined();
  });
});
