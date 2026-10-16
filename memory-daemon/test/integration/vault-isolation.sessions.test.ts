import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { startDaemon, type DaemonStart } from '../../src/daemon/main.js';
import { DaemonClient } from '../../src/mcp/client.js';
import { makeTmpVault, makeTmpIndexDir, type TmpVault } from '../helpers/tmp-vault.js';

/**
 * Session transcripts follow the SESSION's vault.
 *
 * Capture used to write the redacted copy of every chat session into `sessions/`
 * inside `global`, whatever repo the session ran in. Verbatim text from one
 * client's repo was then searchable by an agent working in another client's
 * repo. A transcript is the largest and most detailed content this system keeps,
 * so that one destination defeated the whole read isolation. These cases pin the
 * destination rule for all three marker states, and prove the redaction still
 * applies at the new destination.
 */

const silent = pino({ level: 'silent' });

/** Nothing but the curated seed: the transcripts are what these cases look at. */
const VAULT_FILES = { 'MEMORY.md': '# MEMORY\n\n## Decisions <!-- auto -->\n\n- seed\n' };

/** The phrase that must stay inside one vault. Distinctive on purpose. */
const CLIENT_PHRASE = 'pineapple ledger reconciliation';
/** A secret in the transcript: it must be masked wherever the copy lands. */
const SECRET = 'xK9mQ2vL8pR4tW7zZZ';

function writeTranscript(file: string): void {
  const lines = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: `the ${CLIENT_PHRASE} rule was agreed today` } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'understood' }] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: `my password api_key = ${SECRET} never save this` } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

describe('session transcripts follow the session vault', () => {
  let globalVault: TmpVault;
  let acme: TmpVault;
  let other: TmpVault;
  let index: ReturnType<typeof makeTmpIndexDir>;
  let daemon: DaemonStart;
  let client: DaemonClient;
  let transcript: string;
  const repos: string[] = [];

  /** A repo folder, with the given `.memory.yml` body when one is wanted. */
  const makeRepo = (marker?: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvsess-repo-'));
    repos.push(dir);
    if (marker !== undefined) fs.writeFileSync(path.join(dir, '.memory.yml'), marker, 'utf8');
    return dir;
  };

  const sessionsIn = (root: string): string[] => {
    const dir = path.join(root, 'sessions');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')) : [];
  };

  const readSessions = (root: string): string =>
    sessionsIn(root).map((f) => fs.readFileSync(path.join(root, 'sessions', f), 'utf8')).join('\n');

  const poll = async (fn: () => boolean, ms = 8000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > deadline) throw new Error('poll timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  /** One capture pass from `cwd`, waiting until the copy lands in SOME vault. */
  const captureFrom = async (sessionId: string, cwd: string): Promise<void> => {
    await client.request('capture.turn', { session_id: sessionId, transcript_path: transcript, cwd });
    await poll(() => [globalVault, acme, other].some((v) => sessionsIn(v.root).length > 0));
  };

  /**
   * One capture pass from a repo that has no usable vault, proving no transcript
   * appears anywhere. It cannot poll for an event that never happens, so it gives
   * the background pass a fixed window and then checks all three vaults.
   */
  const expectNoTranscript = async (sessionId: string, cwd: string): Promise<void> => {
    await client.request('capture.turn', { session_id: sessionId, transcript_path: transcript, cwd });
    await new Promise((r) => setTimeout(r, 1500));
    for (const v of [globalVault, acme, other]) expect(sessionsIn(v.root)).toEqual([]);
  };

  beforeEach(async () => {
    globalVault = makeTmpVault(VAULT_FILES, { eol: 'lf' });
    acme = makeTmpVault(VAULT_FILES, { eol: 'lf' });
    other = makeTmpVault(VAULT_FILES, { eol: 'lf' });
    index = makeTmpIndexDir();
    transcript = path.join(index.root, 'transcript.jsonl');
    writeTranscript(transcript);

    const pipePath = process.platform === 'win32'
      ? `\\\\.\\pipe\\memory-vault.sess.${crypto.randomBytes(6).toString('hex')}`
      : path.join(os.tmpdir(), `mv-sess-${crypto.randomBytes(6).toString('hex')}.sock`);
    daemon = await startDaemon({
      pipePath, indexRootDir: index.root, watch: false, embedder: null,
      reconcileIntervalMs: 3_600_000, log: silent, turnsPerPass: 1,
      config: {
        vaults: { global: globalVault.root, acme: acme.root, other: other.root },
        // The daemon's own default is 'other' on purpose. A session in acme's
        // repo must not depend on which repo happened to start the daemon, and a
        // wrong fallback shows up as an 'other' hit.
        defaultVault: 'other',
        embeddings: { enabled: false, model: 'x' },
      },
    });
    client = new DaemonClient({ pipePath, spawnCommand: false });
  });

  afterEach(async () => {
    client.close();
    if (!daemon.alreadyRunning) await daemon.close();
    index.cleanup();
    globalVault.cleanup();
    acme.cleanup();
    other.cleanup();
    for (const dir of repos.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('a session in a repo marked "vault: acme" writes its transcript into acme, and no other vault can read it', async () => {
    await captureFrom('s-acme', makeRepo('vault: acme\n'));

    expect(sessionsIn(acme.root).length).toBe(1);
    expect(sessionsIn(globalVault.root).length).toBe(0);
    expect(sessionsIn(other.root).length).toBe(0);
    expect(readSessions(acme.root)).toContain(CLIENT_PHRASE);

    // Index it, then search the way each caller really searches. The readable
    // set is decided on the server from the one vault name the caller resolved.
    await client.request('reindex');

    const fromOther = await client.request('search', { query: CLIENT_PHRASE, k: 10, vault: 'other' });
    expect(fromOther.hits.some((h) => h.path_hint.startsWith('acme:'))).toBe(false);
    expect(JSON.stringify(fromOther.hits)).not.toContain('pineapple');

    const fromAcme = await client.request('search', { query: CLIENT_PHRASE, k: 10, vault: 'acme' });
    expect(fromAcme.hits.some((h) => h.path_hint.startsWith('acme:sessions/'))).toBe(true);
  });

  it('a repo with no marker still writes into the config default vault', async () => {
    await captureFrom('s-none', makeRepo());

    // 'other' is the config default here. In a normal single-vault setup that
    // default is 'global', so this is the regression guard for that setup too.
    expect(sessionsIn(other.root).length).toBe(1);
    expect(sessionsIn(acme.root).length).toBe(0);
    expect(sessionsIn(globalVault.root).length).toBe(0);
  });

  it('a repo whose marker cannot be honoured writes NO transcript anywhere', async () => {
    // We do not know whose repo this is. The shared vault is no longer a safe
    // parking place: it is a private vault like any other now, so a verbatim
    // client transcript must not land there. The pass is skipped instead, and the
    // watermark stays so the same delta is retried once the marker is fixed.
    await expectNoTranscript('s-broken', makeRepo('vault: nosuchvault\n'));
  });

  it('a malformed marker also writes no transcript', async () => {
    await expectNoTranscript('s-malformed', makeRepo('vault: [unclosed\n'));
  });

  it('BLOCKING REQUIREMENT: the redaction still applies at the new destination', async () => {
    await captureFrom('s-secret', makeRepo('vault: acme\n'));

    const text = readSessions(acme.root);
    expect(text).toContain('[REDACTED:secret.assignment]');
    expect(text).not.toContain(SECRET);
    // The rest of the turn is still there: only the value is masked.
    expect(text).toContain(CLIENT_PHRASE);
  });

  it('forget --purge-sessions reaches a transcript that lives outside global', async () => {
    await captureFrom('s-purge', makeRepo('vault: acme\n'));

    // The scrub is a human-only command. It has to walk every vault now: the
    // transcript it must reach is no longer always in global, and reporting
    // "0 lines scrubbed" while the wording sits on disk would be a false answer.
    const res = await client.request('sessions.purge', { query: CLIENT_PHRASE }) as {
      scannedFiles: number;
      changedFiles: Array<{ path: string; purgedLines: number }>;
      totalPurgedLines: number;
    };

    expect(res.totalPurgedLines).toBe(1);
    expect(res.changedFiles[0]?.path).toMatch(/^acme:sessions\//);
    expect(readSessions(acme.root)).not.toContain(CLIENT_PHRASE);
    expect(readSessions(acme.root)).toContain('[PURGED]');
  });
});
