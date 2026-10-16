import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { startDaemon, type DaemonStart } from '../../src/daemon/main.js';
import { DaemonClient } from '../../src/mcp/client.js';
import { loadConfig, type MemoryConfig } from '../../src/core/config.js';
import { withScopeNotice } from '../../src/core/vault-scope.js';
import { runMutate, runGet, type WriteDeps } from '../../src/daemon/write-pipeline.js';
import { registerTools, type ToolDeps } from '../../src/mcp/tools.js';
import { cmdAdd, cmdGet, cmdShow, type CliCtx } from '../../src/cli/memory.js';
import { openIndexDb } from '../../src/index/db.js';
import type { ChatFn } from '../../src/daemon/capture/extractor.js';
import { makeTmpVault, makeTmpIndexDir, type TmpVault } from '../helpers/tmp-vault.js';
import { CLIENT_A_FILES, CLIENT_B_FILES, GLOBAL_VAULT_FILES } from '../fixtures/multi-vault.js';

/**
 * The WRITE half of vault isolation: a `.memory.yml` marker that cannot be
 * honoured must refuse a project write, never route it to the config default.
 *
 * The danger is the mirror image of the read leak. In a multi-vault setup the
 * default vault is ANOTHER tenant's vault, so one typo in a marker used to send
 * a project note into that tenant's PROJECT.md. Reads fail closed by reading
 * nothing; a write cannot degrade the same way (that would be a different file),
 * so it refuses with VAULT_UNRESOLVED and names the file to fix. Every curated
 * file lives in the caller's own vault now, so all three are covered, not only
 * PROJECT.md.
 *
 * Every case here runs against a config whose default is `clientB`, so any
 * fallback to the default is visible as a clientB write and cannot pass
 * unnoticed. clientB/PROJECT.md is compared byte for byte where it matters.
 */

const silent = pino({ level: 'silent' });

/** A triage response with exactly these items, as the fake extractor. */
const fakeChat = (items: unknown[]): ChatFn => async () => ({
  choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ nothing_to_save: items.length === 0, items }) } }] } }],
});

/** One captured candidate aimed at PROJECT.md, tuned to auto-promote or not. */
const projectItem = (text: string, confidence: number): Record<string, unknown> => ({
  text, class: 'flow_convention', target: 'project', section: 'Decisions',
  confidence, source_turn: 0, duplicate: false, evidence: 'the user said so',
});

describe('a marker that cannot be honoured fails closed for writes', () => {
  let savedEnv: NodeJS.ProcessEnv;
  const tmpDirs: string[] = [];
  let globalVault: TmpVault;
  let clientA: TmpVault;
  let clientB: TmpVault;
  let index: ReturnType<typeof makeTmpIndexDir>;
  let configPath: string;
  let repoTypo: string;
  let repoBroken: string;
  let repoNone: string;
  let repoA: string;
  let daemon: DaemonStart | undefined;
  let pipePath: string;
  let transcript: string;

  function makeDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  /** A repo directory holding exactly this .memory.yml content ('' = no marker). */
  function makeRepo(prefix: string, markerContent?: string): string {
    const repo = makeDir(prefix);
    if (markerContent !== undefined) fs.writeFileSync(path.join(repo, '.memory.yml'), markerContent, 'utf8');
    return repo;
  }

  /** The config a caller in `cwd` sees, loaded the way the CLI and the proxy load it. */
  const configFor = (cwd: string): MemoryConfig => loadConfig({ configPath, cwd });

  /** The config the shared DAEMON has: no cwd, so default_vault (clientB) wins. */
  const daemonConfig = (): MemoryConfig => loadConfig({ configPath });

  const projectFile = (vault: TmpVault): string => path.join(vault.root, 'PROJECT.md');
  const readProject = (vault: TmpVault): string => fs.readFileSync(projectFile(vault), 'utf8');

  /**
   * Starts the one shared daemon these cases talk to. Its own config has NO cwd,
   * exactly like the real thing: it is the vault of whatever repo started it
   * that would be picked if the callers did not resolve their own.
   */
  async function boot(chat?: ChatFn): Promise<void> {
    pipePath = process.platform === 'win32'
      ? `\\\\.\\pipe\\memory-vault.vw.${crypto.randomBytes(6).toString('hex')}`
      : path.join(os.tmpdir(), `mv-vw-${crypto.randomBytes(6).toString('hex')}.sock`);
    daemon = await startDaemon({
      pipePath, indexRootDir: index.root, watch: false, embedder: null,
      reconcileIntervalMs: 3_600_000, log: silent, turnsPerPass: 1,
      ...(chat ? { chat } : {}),
      config: chat
        ? { ...daemonConfig(), openrouter: { apiKey: 'unused-with-fake', model: 'fake' } }
        : daemonConfig(),
    });
  }

  /** A CLI ctx standing in `cwd`, talking to the booted daemon. */
  function mkCtx(cwd: string): { ctx: CliCtx; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const ctx: CliCtx = {
      config: configFor(cwd),
      writeClient: () => new DaemonClient({ pipePath, spawnCommand: false }),
      readClient: () => new DaemonClient({ pipePath, spawnCommand: false }),
      io: { out: (s) => out.push(s), err: (s) => err.push(s), isTTY: false, confirm: undefined },
      indexRootDir: index.root,
      cwd,
    };
    return { ctx, out, err };
  }

  beforeEach(() => {
    savedEnv = { ...process.env };
    // No real config, vault or key variable may reach these cases.
    delete process.env['MEMORY_CONFIG'];
    delete process.env['MEMORY_REPO_CONFIG'];
    delete process.env['OPENROUTER_API_KEY'];
    for (const k of Object.keys(process.env)) {
      if (/^MEMORY_VAULT_/.test(k) || k === 'MEMORY_DEFAULT_VAULT') delete process.env[k];
    }
    process.env['MEMORY_APPDATA_DIR'] = makeDir('mvwrite-appdata-');

    globalVault = makeTmpVault(GLOBAL_VAULT_FILES, { eol: 'lf' });
    clientA = makeTmpVault(CLIENT_A_FILES, { eol: 'lf' });
    clientB = makeTmpVault(CLIENT_B_FILES, { eol: 'lf' });
    index = makeTmpIndexDir();
    transcript = path.join(index.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({
      type: 'user', uuid: 'u1',
      message: { role: 'user', content: 'we always squash merge before release' },
    }) + '\n', 'utf8');

    // default_vault is clientB on purpose: it is the vault a wrong fallback
    // would reach, so every misroute shows up as a clientB write.
    configPath = path.join(makeDir('mvwrite-cfg-'), 'config.local.yml');
    fs.writeFileSync(configPath, [
      'vaults:',
      `  global: ${JSON.stringify(globalVault.root)}`,
      `  clientA: ${JSON.stringify(clientA.root)}`,
      `  clientB: ${JSON.stringify(clientB.root)}`,
      'default_vault: clientB',
      '',
    ].join('\n'), 'utf8');

    repoTypo = makeRepo('mvwrite-typo-', 'vault: clientTYPO\n');
    repoBroken = makeRepo('mvwrite-broken-', 'vault: [unclosed\n');
    repoNone = makeRepo('mvwrite-none-');
    repoA = makeRepo('mvwrite-a-', 'vault: clientA\n');
  });

  afterEach(async () => {
    if (daemon && !daemon.alreadyRunning) await daemon.close();
    daemon = undefined;
    index.cleanup();
    globalVault.cleanup();
    clientA.cleanup();
    clientB.cleanup();
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  describe('the human CLI write', () => {
    it('refuses a project write from a repo whose marker names an unknown vault, and clientB is untouched', async () => {
      await boot();
      const before = readProject(clientB);
      const { ctx } = mkCtx(repoTypo);

      await expect(cmdAdd(['project', 'Decisions', 'never write me into another client'], ctx))
        .rejects.toMatchObject({ code: 'VAULT_UNRESOLVED' });

      // The refusal names the file to fix and the vault the marker asked for,
      // and it says nothing about the other client's vault.
      await cmdAdd(['project', 'Decisions', 'x'], ctx).catch((e: { hint: string }) => {
        expect(e.hint).toContain('.memory.yml');
        expect(e.hint).toContain('clientTYPO');
        expect(e.hint).not.toContain('clientB');
      });

      // Byte for byte: nothing landed in the default vault.
      expect(readProject(clientB)).toBe(before);
      expect(readProject(clientB)).not.toContain('never write me into another client');
    });

    it('refuses a project write from a repo whose marker does not parse', async () => {
      await boot();
      const before = readProject(clientB);
      const { ctx } = mkCtx(repoBroken);
      await expect(cmdAdd(['project', 'Decisions', 'broken yaml must not write'], ctx))
        .rejects.toMatchObject({ code: 'VAULT_UNRESOLVED' });
      expect(readProject(clientB)).toBe(before);
    });

    it('still writes to the marked vault, and to the default vault when there is no marker', async () => {
      // The regression guards. They also prove the two refusals above closed
      // something real: the same command from a good repo does write.
      await boot();

      const a = mkCtx(repoA);
      await cmdAdd(['project', 'Decisions', 'alpha keeps its own decision'], a.ctx);
      expect(a.out.join('\n')).toContain('clientA:PROJECT.md');
      expect(readProject(clientA)).toContain('alpha keeps its own decision');
      expect(readProject(clientB)).not.toContain('alpha keeps its own decision');

      const none = mkCtx(repoNone);
      await cmdAdd(['project', 'Decisions', 'no marker uses the configured default'], none.ctx);
      expect(none.out.join('\n')).toContain('clientB:PROJECT.md');
      expect(readProject(clientB)).toContain('no marker uses the configured default');
    });

    it('a broken marker now blocks the user and memory files too, and nothing lands anywhere', async () => {
      // USER.md and MEMORY.md live in the CALLER's own vault now, so they need
      // the marker just as much as PROJECT.md does. A vault we cannot name has no
      // MEMORY.md we may write to, and writing into the shared vault instead
      // would put this repo's fact in a vault it cannot even read.
      await boot();
      const beforeGlobal = fs.readFileSync(path.join(globalVault.root, 'MEMORY.md'), 'utf8');
      const { ctx } = mkCtx(repoTypo);
      await expect(cmdAdd(['memory', 'Decisions', 'a broken marker must not write anywhere'], ctx))
        .rejects.toMatchObject({ code: 'VAULT_UNRESOLVED' });
      expect(fs.readFileSync(path.join(globalVault.root, 'MEMORY.md'), 'utf8')).toBe(beforeGlobal);
    });

    it('a marked repo writes its OWN user and memory files, not the shared vault ones', async () => {
      // The other half of the same rule: every vault is self-contained.
      await boot();
      const a = mkCtx(repoA);
      await cmdAdd(['memory', 'Decisions', 'alpha keeps its own general memory'], a.ctx);
      expect(a.out.join('\n')).toContain('clientA:MEMORY.md');
      expect(fs.readFileSync(path.join(clientA.root, 'MEMORY.md'), 'utf8'))
        .toContain('alpha keeps its own general memory');
      expect(fs.readFileSync(path.join(globalVault.root, 'MEMORY.md'), 'utf8'))
        .not.toContain('alpha keeps its own general memory');

      await cmdAdd(['user', 'Preferences', 'alpha keeps its own profile line'], a.ctx);
      expect(fs.readFileSync(path.join(clientA.root, 'USER.md'), 'utf8'))
        .toContain('alpha keeps its own profile line');
      expect(fs.readFileSync(path.join(globalVault.root, 'USER.md'), 'utf8'))
        .not.toContain('alpha keeps its own profile line');
    });

    it('a fact reaches the SHARED vault from a folder with no marker', async () => {
      // The documented path for a fact that really belongs to the personal layer:
      // run the CLI from a folder that has no .memory.yml, so the config default
      // decides. Here that default is clientB, so the case uses a folder marked
      // for the shared vault itself, which is the other documented way.
      await boot();
      const repoGlobal = makeRepo('mvwrite-global-', 'vault: global\n');
      const { ctx, out } = mkCtx(repoGlobal);
      await cmdAdd(['memory', 'Decisions', 'a fact that belongs to the personal layer'], ctx);
      expect(out.join('\n')).toContain('global:MEMORY.md');
      expect(fs.readFileSync(path.join(globalVault.root, 'MEMORY.md'), 'utf8'))
        .toContain('a fact that belongs to the personal layer');
    });

    it('share_global does NOT redirect a write: the fact stays in the caller vault', async () => {
      // Sharing is a READ permission. A repo that reads the shared vault still
      // writes into its own, so a client fact can never land in the personal one.
      await boot();
      const repoShared = makeRepo('mvwrite-ashared-', 'vault: clientA\nshare_global: true\n');
      const { ctx, out } = mkCtx(repoShared);
      await cmdAdd(['memory', 'Decisions', 'sharing never redirects a write'], ctx);
      expect(out.join('\n')).toContain('clientA:MEMORY.md');
      expect(fs.readFileSync(path.join(clientA.root, 'MEMORY.md'), 'utf8'))
        .toContain('sharing never redirects a write');
      expect(fs.readFileSync(path.join(globalVault.root, 'MEMORY.md'), 'utf8'))
        .not.toContain('sharing never redirects a write');
    });
  });

  describe('the daemon write pipeline itself', () => {
    /**
     * A daemon whose OWN config carries the broken marker: the case of a daemon
     * started inside the typo'd repo. The pipeline has to refuse by itself here,
     * not only because a client checked first.
     */
    function depsFor(cwd: string): { deps: WriteDeps; close(): void } {
      const db = openIndexDb({ rootDir: index.root });
      const deps: WriteDeps = {
        db, config: configFor(cwd), log: silent, indexerCtxFor: () => undefined,
      };
      return { deps, close: () => db.close() };
    }

    it('runMutate refuses file:project under a broken marker, even when the request names clientB', async () => {
      const before = readProject(clientB);
      const { deps, close } = depsFor(repoTypo);
      try {
        // The request explicitly asks for clientB. Under a broken marker the
        // pipeline refuses before any vault name is chosen, so a client that
        // forgot to resolve its own vault still cannot misroute the write.
        await expect(runMutate(deps, {
          file: 'project',
          vault: 'clientB',
          expect: { sectionHash: 'whatever' },
          ops: [{ op: 'add', section: 'Decisions', text: 'pipeline must refuse this', source: 'user' }],
          actor: 'user_cli',
        })).rejects.toMatchObject({ code: 'VAULT_UNRESOLVED' });
      } finally {
        close();
      }
      expect(readProject(clientB)).toBe(before);
    });

    it('runGet refuses file:project under a broken marker too', () => {
      const { deps, close } = depsFor(repoTypo);
      try {
        expect(() => runGet(deps.config, { file: 'project', vault: 'clientB' }))
          .toThrowError(expect.objectContaining({ code: 'VAULT_UNRESOLVED' }));
      } finally {
        close();
      }
    });

    it('the same pipeline still writes when the marker is valid', async () => {
      const { deps, close } = depsFor(repoA);
      try {
        const view = runGet(deps.config, { file: 'project', vault: 'clientA' }) as {
          sections: Array<{ name: string; section_hash: string }>;
        };
        const section = view.sections.find((s) => s.name === 'Decisions')!;
        await runMutate(deps, {
          file: 'project',
          vault: 'clientA',
          expect: { sectionHash: section.section_hash },
          ops: [{ op: 'add', section: 'Decisions', text: 'valid marker writes normally', source: 'user' }],
          actor: 'user_cli',
        });
      } finally {
        close();
      }
      expect(readProject(clientA)).toContain('valid marker writes normally');
      expect(readProject(clientB)).not.toContain('valid marker writes normally');
    });
  });

  describe('the MCP proxy write', () => {
    /** Registers the tools against fakes and reports what reached the daemon. */
    function proxy(cwd: string) {
      const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
      const fakeServer = {
        registerTool: (name: string, _cfg: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
          handlers.set(name, handler);
        },
      };
      let captured: { method: string; params: Record<string, unknown> } | undefined;
      const fakeClient = {
        request: (method: string, params: Record<string, unknown>) => {
          captured = { method, params };
          return Promise.resolve({ ok: true });
        },
        close: () => { /* nothing to close in the fake */ },
      };
      const deps: ToolDeps = {
        getConfig: () => configFor(cwd),
        getDb: () => { throw new Error('the write cases never read the index'); },
        client: fakeClient as unknown as ToolDeps['client'],
      };
      registerTools(fakeServer as unknown as Parameters<typeof registerTools>[0], deps);
      return { handlers, get captured() { return captured; } };
    }

    const envelopeOf = (res: unknown): { ok: boolean; error?: { code: string; hint: string } } =>
      JSON.parse((res as { content: Array<{ text: string }> }).content[0]!.text);

    it('memory_add on the project file never leaves the proxy under a broken marker', async () => {
      const ctx = proxy(repoTypo);
      const res = await ctx.handlers.get('memory_add')!({
        file: 'project', expect: { sectionHash: 'h' },
        ops: [{ op: 'add', section: 'Decisions', text: 'agent write from a typo repo' }],
      });
      const body = envelopeOf(res);
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe('VAULT_UNRESOLVED');
      // Nothing reached the daemon: the daemon is shared, so its own config
      // cannot see that THIS caller's marker is broken and it could not refuse.
      expect(ctx.captured).toBeUndefined();
    });

    it('memory_add still stamps the real vault with a valid marker, and the default with none', async () => {
      const valid = proxy(repoA);
      await valid.handlers.get('memory_add')!({
        file: 'project', expect: { sectionHash: 'h' },
        ops: [{ op: 'add', section: 'Decisions', text: 'ok' }],
      });
      expect(valid.captured?.params['vault']).toBe('clientA');

      const none = proxy(repoNone);
      await none.handlers.get('memory_add')!({
        file: 'project', expect: { sectionHash: 'h' },
        ops: [{ op: 'add', section: 'Decisions', text: 'ok' }],
      });
      expect(none.captured?.params['vault']).toBe('clientB');
    });

    it('memory_add on the memory file is refused under a broken marker too', async () => {
      // It used to be exempt, because USER.md and MEMORY.md lived in the shared
      // vault. They live in the caller's own vault now, so an unknown caller has
      // no file to write to and the request never leaves the proxy.
      const ctx = proxy(repoTypo);
      const res = await ctx.handlers.get('memory_add')!({
        file: 'memory', expect: { sectionHash: 'h' },
        ops: [{ op: 'add', section: 'Decisions', text: 'shared write' }],
      });
      const body = envelopeOf(res);
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe('VAULT_UNRESOLVED');
      expect(ctx.captured).toBeUndefined();
    });

    it('memory_add on the memory file stamps the CALLER vault, never the shared one', async () => {
      const valid = proxy(repoA);
      await valid.handlers.get('memory_add')!({
        file: 'memory', expect: { sectionHash: 'h' },
        ops: [{ op: 'add', section: 'Decisions', text: 'ok' }],
      });
      expect(valid.captured?.params['vault']).toBe('clientA');

      // Even with the read opt-in, the write target is unchanged.
      const shared = proxy(makeRepo('mvwrite-proxyshared-', 'vault: clientA\nshare_global: true\n'));
      await shared.handlers.get('memory_add')!({
        file: 'user', expect: { sectionHash: 'h' },
        ops: [{ op: 'add', section: 'Preferences', text: 'ok' }],
      });
      expect(shared.captured?.params['vault']).toBe('clientA');
    });
  });

  describe('the human CLI curated reads', () => {
    it('memory show does not print the default vault PROJECT.md under a broken marker', async () => {
      await boot();
      const typo = mkCtx(repoTypo);
      await cmdShow([], typo.ctx);
      const printed = typo.out.join('\n');
      expect(printed).not.toContain('BETA_PROJECT_MARKER');
      expect(printed).not.toContain('clientB:PROJECT.md');

      // Regression guard: the same command from the marked repo does show it.
      const a = mkCtx(repoA);
      await cmdShow([], a.ctx);
      expect(a.out.join('\n')).toContain('ALPHA_PROJECT_MARKER');
    });

    it('memory get project is refused by name instead of printing another vault', async () => {
      await boot();
      const { ctx } = mkCtx(repoTypo);
      await expect(cmdGet(['project'], ctx)).rejects.toMatchObject({ code: 'VAULT_UNRESOLVED' });

      const a = mkCtx(repoA);
      await cmdGet(['project'], a.ctx);
      expect(a.out.join('\n')).toContain('ALPHA_PROJECT_MARKER');
    });
  });

  describe('capture auto-promotion', () => {
    const poll = async (fn: () => Promise<boolean>, ms = 8000): Promise<void> => {
      const until = Date.now() + ms;
      for (;;) {
        if (await fn()) return;
        if (Date.now() > until) throw new Error('condition never became true');
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    it('auto-promote from a clientA session lands in clientA, never in the daemon default vault', async () => {
      await boot(fakeChat([projectItem('squash merges before every release', 0.95)]));
      const client = new DaemonClient({ pipePath, spawnCommand: false });
      try {
        await client.request('capture.turn', { session_id: 'auto-a', transcript_path: transcript, cwd: repoA });
        await poll(async () => readProject(clientA).includes('squash merges before every release'));
      } finally {
        client.close();
      }
      expect(readProject(clientB)).not.toContain('squash merges before every release');
    });

    it('a broken-marker session captures nothing at all: no item, no transcript', async () => {
      const before = [globalVault, clientA, clientB].map((v) => ({
        project: fs.existsSync(path.join(v.root, 'PROJECT.md')) ? fs.readFileSync(path.join(v.root, 'PROJECT.md'), 'utf8') : '',
        memory: fs.readFileSync(path.join(v.root, 'MEMORY.md'), 'utf8'),
      }));
      // Both items would qualify on content. The whole pass is refused instead,
      // because the session has no vault it may use: there is no shared vault to
      // fall back to any more.
      await boot(fakeChat([
        projectItem('typo repo fact that must never land', 0.95),
        {
          text: 'a second fact that must not land either', class: 'flow_convention',
          target: 'memory', section: 'Decisions', confidence: 0.95, source_turn: 0,
          duplicate: false, evidence: 'the user said so',
        },
      ]));
      const client = new DaemonClient({ pipePath, spawnCommand: false });
      try {
        await client.request('capture.turn', { session_id: 'auto-typo', transcript_path: transcript, cwd: repoTypo });
        // Nothing to poll for, so give the background pass a fixed window.
        await new Promise((r) => setTimeout(r, 1500));
      } finally {
        client.close();
      }
      // Every vault is byte-identical, no transcript was written, and there is no
      // queue left for the dropped items to wait in.
      [globalVault, clientA, clientB].forEach((v, i) => {
        const project = fs.existsSync(path.join(v.root, 'PROJECT.md')) ? fs.readFileSync(path.join(v.root, 'PROJECT.md'), 'utf8') : '';
        expect(project).toBe(before[i]!.project);
        expect(fs.readFileSync(path.join(v.root, 'MEMORY.md'), 'utf8')).toBe(before[i]!.memory);
        expect(fs.existsSync(path.join(v.root, 'sessions'))).toBe(false);
        expect(fs.existsSync(path.join(v.root, 'pending'))).toBe(false);
      });
    });
  });

  describe('the broken marker is visible in the search response', () => {
    /** Registers the tools against a fake daemon that returns an empty result. */
    function searchProxy(cwd: string) {
      const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
      const fakeServer = {
        registerTool: (name: string, _cfg: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
          handlers.set(name, handler);
        },
      };
      const fakeClient = {
        request: () => Promise.resolve({ query_kind: 'natural', hits: [] }),
        close: () => { /* nothing to close in the fake */ },
      };
      const deps: ToolDeps = {
        getConfig: () => configFor(cwd),
        getDb: () => { throw new Error('the daemon path never opens the index'); },
        client: fakeClient as unknown as ToolDeps['client'],
      };
      registerTools(fakeServer as unknown as Parameters<typeof registerTools>[0], deps);
      return handlers;
    }

    const searchData = async (cwd: string): Promise<Record<string, unknown>> => {
      const res = await searchProxy(cwd).get('memory_search')!({ query: 'quarterly billing migration' });
      const body = JSON.parse((res as { content: Array<{ text: string }> }).content[0]!.text) as
        { ok: boolean; data: Record<string, unknown> };
      expect(body.ok).toBe(true);
      return body.data;
    };

    it('memory_search explains the narrowed scope when the marker names an unknown vault', async () => {
      const data = await searchData(repoTypo);
      const notice = data['scope_notice'] as string;
      expect(notice).toBeDefined();
      // It says what happened, what was searched, and how to fix it — without
      // naming the other configured vaults.
      expect(notice).toContain('no vault could be searched here');
      expect(notice).toContain('.memory.yml');
      expect(notice).toContain('memory vault add clientTYPO');
      expect(notice).not.toContain('clientB');
    });

    it('memory_search explains it for a marker that does not parse too', async () => {
      const notice = (await searchData(repoBroken))['scope_notice'] as string;
      expect(notice).toBeDefined();
      expect(notice).toContain('could not be read');
      expect(notice).not.toContain('clientB');
    });

    it('memory_search carries no notice when the marker is valid or absent', async () => {
      expect((await searchData(repoA))['scope_notice']).toBeUndefined();
      expect((await searchData(repoNone))['scope_notice']).toBeUndefined();
    });

    it('the human CLI attaches the same field to its own result', () => {
      // cmdSearch runs its result through withScopeNotice, so `--json` at the
      // terminal shows the human exactly what the agent sees.
      const base = { query_kind: 'natural' as const, hits: [] };
      expect(withScopeNotice(configFor(repoTypo), base)['scope_notice']).toBeDefined();
      expect(withScopeNotice(configFor(repoA), base)['scope_notice']).toBeUndefined();
      expect(withScopeNotice(configFor(repoNone), base)['scope_notice']).toBeUndefined();
    });
  });
});
