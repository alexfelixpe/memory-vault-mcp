import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { startDaemon, type DaemonStart } from '../../src/daemon/main.js';
import { DaemonClient } from '../../src/mcp/client.js';
import {
  dispatch, cmdGet, cmdAdd, cmdEdit, cmdForget, cmdShow, cmdLog, type CliCtx,
} from '../../src/cli/memory.js';
import { runReset } from '../../src/cli/reset.js';
import { writeLogPath } from '../../src/core/write-log.js';
import { makeTmpVault, makeTmpIndexDir, type TmpVault } from '../helpers/tmp-vault.js';
import type { MemoryConfig } from '../../src/core/config.js';

/**
 * The human memory-management verbs (get/add/edit/forget/show/log) round-tripped
 * through a real daemon on a temp vault + temp index. Hermetic: never touches the
 * developer's real vault, config or index. Mirrors the write.test.ts harness (one
 * pipe per test, embedder off, no watcher).
 */

const silent = pino({ level: 'silent' });

const VAULT = {
  'USER.md': '# USER\n\n## Preferences <!-- auto -->\n\n- Short answers\n',
  'MEMORY.md': '# MEMORY\n\n## Notes <!-- auto -->\n\n- Uses Windows 11\n\n## Profile\n\n- Human-only section.\n',
};

describe('human CLI verbs (get/add/edit/forget/show/log)', () => {
  let vault: TmpVault;
  let index: ReturnType<typeof makeTmpIndexDir>;
  let daemon: DaemonStart;
  let raw: DaemonClient;
  let pipePath: string;
  let config: MemoryConfig;

  /** A ctx wired to the test daemon + temp index, capturing stdout/stderr. */
  const mkCtx = (over: Partial<CliCtx['io']> = {}): { ctx: CliCtx; out: string[]; err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    const ctx: CliCtx = {
      config,
      writeClient: () => new DaemonClient({ pipePath, spawnCommand: false }),
      readClient: () => new DaemonClient({ pipePath, spawnCommand: false }),
      io: { out: (s) => out.push(s), err: (s) => err.push(s), isTTY: false, confirm: undefined, ...over },
      indexRootDir: index.root,
    };
    return { ctx, out, err };
  };

  beforeEach(async () => {
    vault = makeTmpVault(VAULT, { eol: 'lf' });
    index = makeTmpIndexDir();
    pipePath = process.platform === 'win32'
      ? `\\\\.\\pipe\\memory-vault.cli.${crypto.randomBytes(6).toString('hex')}`
      : path.join(os.tmpdir(), `mv-cli-${crypto.randomBytes(6).toString('hex')}.sock`);
    config = { vaults: { global: vault.root }, defaultVault: 'global', embeddings: { enabled: false, model: 'x' } };
    daemon = await startDaemon({
      pipePath, indexRootDir: index.root, watch: false, embedder: null,
      reconcileIntervalMs: 3_600_000, log: silent, config,
    });
    raw = new DaemonClient({ pipePath, spawnCommand: false });
  });

  afterEach(async () => {
    raw.close();
    if (!daemon.alreadyRunning) await daemon.close();
    index.cleanup();
    vault.cleanup();
  });

  it('add: a human fact lands in the file, in get, and in search', async () => {
    const add = mkCtx();
    await cmdAdd(['memory', 'Notes', 'Alice prefers the color zephyrmauve for dashboards'], add.ctx);
    expect(add.out.join('\n')).toMatch(/added: global:MEMORY\.md/);

    // Round-trips through get (the human reads it back).
    const get = mkCtx();
    await cmdGet(['memory', 'Notes'], get.ctx);
    expect(get.out.join('\n')).toContain('zephyrmauve');

    // Written with human_direct provenance (src:human), via the single pipeline.
    expect(fs.readFileSync(path.join(vault.root, 'MEMORY.md'), 'utf8')).toMatch(/zephyrmauve.*src:human/);

    // And it is searchable immediately (the pipeline re-indexes on write).
    const res = await raw.request('search', { query: 'zephyrmauve', scope: 'curated' });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits.some((h) => h.path_hint.includes('MEMORY.md'))).toBe(true);
  });

  it('add: a human at the CLI may write into a non-auto section (blocker fix)', async () => {
    // The auto-section gate stops AGENTS; a human typing at the CLI states their
    // own curated memory and is allowed into ANY section (the daemon stamps
    // actor 'user_cli'). Previously this was wrongly refused with SECTION_NOT_AUTO.
    const add = mkCtx();
    await cmdAdd(['memory', 'Profile', 'Alice owns the roadmap'], add.ctx);
    expect(add.out.join('\n')).toMatch(/added: global:MEMORY\.md/);
    expect(fs.readFileSync(path.join(vault.root, 'MEMORY.md'), 'utf8')).toContain('Alice owns the roadmap');
  });

  it('get --hashes exposes the section and entry hashes the human never has to type', async () => {
    const get = mkCtx();
    await cmdGet(['memory', 'Notes', '--hashes'], get.ctx);
    const text = get.out.join('\n');
    expect(text).toMatch(/section hash: [0-9a-f]{64}/);
    expect(text).toMatch(/entry hash: [0-9a-f]{64}/);
  });

  it('edit: replaces an entry; get shows the new text and not the old', async () => {
    await cmdAdd(['memory', 'Notes', 'temporary draft note'], mkCtx().ctx);
    const edit = mkCtx();
    await cmdEdit(['memory', 'Notes', '--match', 'temporary draft', '--text', 'final approved note'], edit.ctx);
    expect(edit.out.join('\n')).toMatch(/replaced: global:MEMORY\.md/);

    const get = mkCtx();
    await cmdGet(['memory', 'Notes'], get.ctx);
    const text = get.out.join('\n');
    expect(text).toContain('final approved note');
    expect(text).not.toContain('temporary draft');
  });

  it('forget: removes the curated entry and prints the honest residue notice', async () => {
    await cmdAdd(['memory', 'Notes', 'forgettable secret hobby detail'], mkCtx().ctx);

    const forget = mkCtx();
    await cmdForget(['forgettable secret hobby', '--yes'], forget.ctx);
    const text = forget.out.join('\n');
    expect(text).toMatch(/Will remove 1 curated entry/);
    expect(text).toMatch(/Removed 1 of 1/);
    // The residue notice must name backups, archive and sessions.
    expect(text).toContain('Residue notice');
    expect(text).toMatch(/a\) backups:/);
    expect(text).toMatch(/b\) archive:/);
    expect(text).toMatch(/c\) sessions:/);

    // Gone from get AND from search.
    const get = mkCtx();
    await cmdGet(['memory', 'Notes'], get.ctx);
    expect(get.out.join('\n')).not.toContain('forgettable secret hobby');
    const res = await raw.request('search', { query: 'forgettable secret hobby', scope: 'curated' });
    expect(res.hits.some((h) => h.snippet.includes('forgettable secret hobby'))).toBe(false);
  });

  it('forget: non-interactive without --yes refuses and removes nothing', async () => {
    await cmdAdd(['memory', 'Notes', 'keep this exact line please'], mkCtx().ctx);
    // isTTY:false and no confirm => must refuse (never delete silently in a script).
    await expect(cmdForget(['keep this exact line'], mkCtx().ctx)).rejects.toThrow(/confirmation/);
    const get = mkCtx();
    await cmdGet(['memory', 'Notes'], get.ctx);
    expect(get.out.join('\n')).toContain('keep this exact line please');
  });

  it('forget --purge-backups deletes only the .bak files that contain the text', async () => {
    // First add creates a backup of the seed (no token). The second write backs
    // up the version that DOES contain the token — that is the one to purge.
    await cmdAdd(['memory', 'Notes', 'purgetoken alpha entry'], mkCtx().ctx);
    await cmdAdd(['memory', 'Notes', 'second unrelated entry'], mkCtx().ctx);

    const backupDir = path.join(vault.root, '.memory', 'backups');
    const baksWith = (): string[] => fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter((f) => f.endsWith('.bak'))
          .filter((f) => fs.readFileSync(path.join(backupDir, f), 'utf8').includes('purgetoken'))
      : [];
    expect(baksWith().length).toBeGreaterThan(0);

    const forget = mkCtx();
    await cmdForget(['purgetoken alpha', '--yes', '--purge-backups'], forget.ctx);
    expect(forget.out.join('\n')).toMatch(/purged \d+ \.bak file\(s\)/);
    expect(baksWith().length).toBe(0);
  });

  it('show: lists curated content and a count + location for every other layer', async () => {
    await cmdAdd(['memory', 'Notes', 'a durable curated fact'], mkCtx().ctx);

    // Seed the other layers on disk.
    fs.mkdirSync(path.join(vault.root, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(vault.root, 'sessions', '2026-07-25-abcd1234.md'), '# Session\n');
    fs.mkdirSync(path.join(vault.root, 'daily'), { recursive: true });
    fs.writeFileSync(path.join(vault.root, 'daily', '2026-07-25.md'), '# 2026-07-25\n\n- fact: a\n- fact: b\n');
    fs.mkdirSync(path.join(vault.root, 'digests'), { recursive: true });
    fs.writeFileSync(path.join(vault.root, 'digests', '2026-W30.md'), '# digest\n');

    const show = mkCtx();
    await cmdShow(['--all'], show.ctx);
    const text = show.out.join('\n');
    expect(text).toContain('=== Curated memory');
    expect(text).toContain('a durable curated fact');
    expect(text).toContain('=== Other memory layers');
    // Every count names the vault it came from: sessions and daily can now live
    // in a project vault, so a bare number would be ambiguous.
    expect(text).toMatch(/sessions\s+global\s+1 transcript file\(s\)/);
    expect(text).toMatch(/daily\s+global\s+1 day file\(s\), 2 entries/);
    // digests can live in any readable vault now, so the row names them all in
    // its location column instead of assuming the shared vault.
    expect(text).toMatch(/digests\s+-\s+1 file\(s\)\s+global:digests/);
    expect(text).toMatch(/backups\s+-\s+\d+ \.bak file\(s\)/);
    // --all lists the individual file names.
    expect(text).toContain('2026-07-25-abcd1234.md');
  });

  it('log: shows the write audit trail with the actor that wrote each entry', async () => {
    await cmdAdd(['memory', 'Notes', 'audited fact one'], mkCtx().ctx);
    const log = mkCtx();
    await cmdLog(['--limit', '10'], log.ctx);
    const text = log.out.join('\n');
    expect(text).toContain('user_cli');
    expect(text).toContain('MEMORY.md');
  });

  it('log: SURVIVES a reset — the durable write log is not in the rebuildable index', async () => {
    await cmdAdd(['memory', 'Notes', 'durable audit fact'], mkCtx().ctx);
    // The durable JSONL lives under the vault's .memory/, separate from the index.
    const durable = writeLogPath(vault.root);
    expect(fs.existsSync(durable)).toBe(true);

    // Release the index handle so reset can delete it on Windows.
    if (!daemon.alreadyRunning) await daemon.close();

    // reset clears the rebuildable index; it must NOT touch the durable audit
    // log under .memory/.
    runReset({ indexDir: index.root, vaults: config.vaults });
    expect(fs.existsSync(index.root)).toBe(false); // the index is gone
    expect(fs.existsSync(durable)).toBe(true);     // the audit trail survived

    // memory log reads the durable store (no daemon, no index) and still has it.
    const log = mkCtx();
    await cmdLog(['--limit', '10'], log.ctx);
    const text = log.out.join('\n');
    expect(text).toContain('user_cli');
    expect(text).toContain('MEMORY.md');
    expect(text).toContain('Notes');
  });

  it('log: shows WHICH app wrote a memory (per-app identity from the MCP handshake)', async () => {
    // An MCP write from a named app carries its client label through the pipe.
    const view = await raw.request('get', { file: 'memory', vault: 'global', section: 'Notes' }) as {
      sections: Array<{ name: string; section_hash: string }>;
    };
    await raw.request('mutate', {
      file: 'memory', vault: 'global',
      expect: { sectionHash: view.sections[0]!.section_hash },
      ops: [{ op: 'add', section: 'Notes', text: 'an app wrote this line', source: 'inferred' }],
      actor: 'memory_add', client: 'Claude Desktop',
    });
    const log = mkCtx();
    await cmdLog(['--limit', '10'], log.ctx);
    expect(log.out.join('\n')).toContain('(app: Claude Desktop)');
  });

  it('log: records the claimed source, so a smuggled source:"user" is visible in the trail', async () => {
    // A human CLI add carries source:'user'; an agent write carries its own.
    // memory log shows both, next to the server-set actor.
    await cmdAdd(['memory', 'Notes', 'a human-typed audited fact'], mkCtx().ctx);
    const view = await raw.request('get', { file: 'memory', vault: 'global', section: 'Notes' }) as {
      sections: Array<{ name: string; section_hash: string }>;
    };
    await raw.request('mutate', {
      file: 'memory', vault: 'global',
      expect: { sectionHash: view.sections[0]!.section_hash },
      ops: [{ op: 'add', section: 'Notes', text: 'an agent-inferred fact', source: 'inferred' }],
      actor: 'memory_add',
    });

    const log = mkCtx();
    await cmdLog(['--limit', '10'], log.ctx);
    const text = log.out.join('\n');
    expect(text).toContain('src:user');      // the human CLI add (source: 'user')
    expect(text).toContain('src:inferred');  // the agent write (source: 'inferred')
  });

  it('forget --purge-sessions scrubs matching lines from session transcripts', async () => {
    // The phrase lives both in a curated entry and in a redacted transcript.
    await cmdAdd(['memory', 'Notes', 'my secret passphrase pineapple'], mkCtx().ctx);
    fs.mkdirSync(path.join(vault.root, 'sessions'), { recursive: true });
    const sessionFile = path.join(vault.root, 'sessions', '2026-07-25-deadbeef.md');
    fs.writeFileSync(sessionFile,
      '# Session\n\n- user: tell me my secret passphrase pineapple please\n- assistant: ok noted\n');

    const forget = mkCtx();
    await cmdForget(['secret passphrase pineapple', '--yes', '--purge-sessions'], forget.ctx);
    const text = forget.out.join('\n');
    expect(text).toMatch(/Removed 1 of 1/);
    expect(text).toMatch(/c\) sessions: scrubbed 1 line/);
    expect(text).toMatch(/d\) git history:/);

    // Only the matching line becomes [PURGED]; the rest of the transcript stays.
    const after = fs.readFileSync(sessionFile, 'utf8');
    expect(after).not.toContain('pineapple');
    expect(after).toContain('[PURGED]');
    expect(after).toContain('assistant: ok noted');
  });

  it('forget WITHOUT --purge-sessions leaves session transcripts untouched', async () => {
    await cmdAdd(['memory', 'Notes', 'another secret mango phrase'], mkCtx().ctx);
    fs.mkdirSync(path.join(vault.root, 'sessions'), { recursive: true });
    const sessionFile = path.join(vault.root, 'sessions', '2026-07-25-cafe.md');
    fs.writeFileSync(sessionFile, '# Session\n\n- user: another secret mango phrase\n');

    await cmdForget(['secret mango phrase', '--yes'], mkCtx().ctx);
    // The default forget never scrubs sessions/.
    expect(fs.readFileSync(sessionFile, 'utf8')).toContain('mango');
  });

  it('forget --purge-sessions scrubs sessions even when no curated entry matches', async () => {
    // The phrase is only in a transcript (already gone from curated memory).
    fs.mkdirSync(path.join(vault.root, 'sessions'), { recursive: true });
    const sessionFile = path.join(vault.root, 'sessions', '2026-07-25-orphan.md');
    fs.writeFileSync(sessionFile, '# Session\n\n- user: leftover coconut phrase here\n');

    const forget = mkCtx();
    await cmdForget(['leftover coconut phrase', '--yes', '--purge-sessions'], forget.ctx);
    const text = forget.out.join('\n');
    expect(text).toMatch(/No curated memory matched/);
    expect(text).toMatch(/c\) sessions: scrubbed 1 line/);
    expect(fs.readFileSync(sessionFile, 'utf8')).not.toContain('coconut');
  });

  it('status: the daemon reports captureOn=false when no OpenRouter key is configured', async () => {
    // The test config carries no openrouter block, so egress is off. The status
    // line the CLI renders (captureEgressLine) reads exactly this boolean.
    const s = await raw.request('status');
    expect(s.captureOn).toBe(false);
  });

  it('dispatch: an unknown command prints usage to stderr and exits non-zero', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await dispatch(['totally-bogus-command'])).toBe(1);
      const written = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('unknown command');
      expect(written).toContain('usage:');
    } finally {
      spy.mockRestore();
    }
  });

  // The review queue was removed on 2026-07-28. `memory pending` must fail like
  // any other typo, and no subcommand of it may survive as a hidden path.
  it('dispatch: `memory pending` is gone and reads as an unknown command', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      for (const argv of [['pending'], ['pending', 'accept', '01ab23cd'], ['pending', 'reject', '--all', '--yes']]) {
        expect(await dispatch(argv)).toBe(1);
      }
      const written = err.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain("unknown command 'pending'");
      // The usage text must not advertise it either.
      expect(written).not.toContain('memory pending');
      expect(out.mock.calls.length).toBe(0);
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });

  // Asking for help is a request, not a mistake. All four forms used to fall
  // into the unknown-command default and exit 1, while docs/agent-guide.md told
  // the reader to run `memory --help`.
  it('dispatch: --help, -h, help and a bare `memory` print usage to stdout and exit 0', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for (const argv of [['--help'], ['-h'], ['help'], []]) {
        expect(await dispatch(argv)).toBe(0);
      }
      const written = out.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('usage:');
      expect(written).toContain('memory search');
      // Help is never an error: nothing goes to stderr, and it never reads as a typo.
      expect(err.mock.calls.length).toBe(0);
      expect(written).not.toContain('unknown command');
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it('dispatch: --version and -v print the version cleanly and exit 0', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await dispatch(['--version'])).toBe(0);
      expect(await dispatch(['-v'])).toBe(0);
      const written = spy.mock.calls.map((c) => String(c[0])).join('');
      // A real semver-shaped version, never the "unknown command" line.
      expect(written).toMatch(/\d+\.\d+\.\d+/);
      expect(written).not.toContain('unknown command');
    } finally {
      spy.mockRestore();
    }
  });
});
