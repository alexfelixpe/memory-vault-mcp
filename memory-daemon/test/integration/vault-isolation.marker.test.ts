import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import type Database from 'better-sqlite3';
import { openIndexDb } from '../../src/index/db.js';
import { reconcileVault } from '../../src/index/reconcile.js';
import { loadRegistryVocab } from '../../src/core/identifiers.js';
import { loadConfig, type MemoryConfig } from '../../src/core/config.js';
import { readableVaults } from '../../src/core/vault-scope.js';
import { buildSearchContext } from '../../src/index/context.js';
import { memorySearch, type SearchHit } from '../../src/index/search/search.js';
import { resolveSearchVault } from '../../src/cli/memory.js';
import { registerTools, type ToolDeps } from '../../src/mcp/tools.js';
import { resolveSessionVault, resolveSessionScope } from '../../src/daemon/write-pipeline.js';
import { CaptureManager } from '../../src/daemon/capture/index.js';
import type { ChatFn } from '../../src/daemon/capture/extractor.js';
import { makeTmpVault, makeTmpIndexDir, type TmpVault } from '../helpers/tmp-vault.js';
import { CLIENT_A_FILES, CLIENT_B_FILES, GLOBAL_VAULT_FILES, SHARED_QUERY } from '../fixtures/multi-vault.js';

/**
 * A `.memory.yml` marker that cannot be honoured must fail CLOSED for reads.
 *
 * The danger is quiet: a typo in the marker, or a vault removed from config,
 * used to drop the marker and fall back to `default_vault`. In a multi-vault
 * setup that default is ANOTHER tenant's vault, so one typo turned a search into
 * a cross-tenant read. These cases pin the four-way rule (no marker / broken
 * marker / valid marker / valid marker with `share_global: true`) on every read
 * path: the human CLI, the MCP proxy, the daemon session resolver, and the
 * capture triage prompt that leaves the machine.
 *
 * The whole file runs against a config whose default is `clientB`, so any
 * fallback to the default is visible as a clientB hit and cannot pass unnoticed.
 */

const silent = pino({ level: 'silent' });

/** Every path_hint of a result, as "<vault>:<path>". */
const hints = (hits: SearchHit[]): string[] => hits.map((h) => h.path_hint);

/** The vault name of every hit, deduplicated. */
const vaultsOf = (hits: SearchHit[]): string[] => [...new Set(hints(hits).map((h) => h.split(':')[0]!))];

/**
 * A curated note for a client vault. Root PROJECT.md is not classified as the
 * curated layer today, so the frontmatter override is what puts real curated
 * content inside a client vault. The capture triage prompt reads exactly this
 * layer, so it is what the egress test needs.
 */
const curatedNote = (marker: string): Record<string, string> => ({
  'Notes/client-curated.md': `---\nlayer: curated\n---\n# Client curated\n\n- ${marker} the quarterly billing migration is reviewed twice for this client.\n`,
});

describe('a marker that cannot be honoured fails closed for reads', () => {
  let savedEnv: NodeJS.ProcessEnv;
  const tmpDirs: string[] = [];
  let globalVault: TmpVault;
  let clientA: TmpVault;
  let clientB: TmpVault;
  let index: ReturnType<typeof makeTmpIndexDir>;
  let db: Database.Database;
  let configPath: string;
  /** Repos, one per marker case. */
  let repoTypo: string;
  let repoBroken: string;
  let repoNone: string;
  let repoA: string;
  /** clientA's repo, with the shared vault invited in on purpose. */
  let repoAShared: string;

  /** A temp directory that stands in for a repo or a config folder. */
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

  /** The hits a plain `memory search` returns from `cwd`, with no --vault flag. */
  async function searchFrom(cwd: string): Promise<SearchHit[]> {
    const config = configFor(cwd);
    const vault = resolveSearchVault(config, undefined);
    const ctx = buildSearchContext(db, config, undefined, readableVaults(config, vault, config.shareGlobal));
    return (await memorySearch(ctx, { query: SHARED_QUERY, k: 10 })).hits;
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
    process.env['MEMORY_APPDATA_DIR'] = makeDir('mvmark-appdata-');

    globalVault = makeTmpVault(GLOBAL_VAULT_FILES, { eol: 'lf' });
    clientA = makeTmpVault({ ...CLIENT_A_FILES, ...curatedNote('ALPHA_CURATED_MARKER') }, { eol: 'lf' });
    clientB = makeTmpVault({ ...CLIENT_B_FILES, ...curatedNote('BETA_CURATED_MARKER') }, { eol: 'lf' });
    index = makeTmpIndexDir();
    db = openIndexDb({ rootDir: index.root });

    // default_vault is clientB on purpose: it is the vault a wrong fallback
    // would reach, so every leak shows up as a clientB hit.
    configPath = path.join(makeDir('mvmark-cfg-'), 'config.local.yml');
    fs.writeFileSync(configPath, [
      'vaults:',
      `  global: ${JSON.stringify(globalVault.root)}`,
      `  clientA: ${JSON.stringify(clientA.root)}`,
      `  clientB: ${JSON.stringify(clientB.root)}`,
      'default_vault: clientB',
      '',
    ].join('\n'), 'utf8');

    for (const [name, root] of [['global', globalVault.root], ['clientA', clientA.root], ['clientB', clientB.root]] as const) {
      reconcileVault({ db, vaultName: name, vaultRoot: root, vocab: loadRegistryVocab(root) });
    }

    repoTypo = makeRepo('mvmark-typo-', 'vault: clientTYPO\n');
    repoBroken = makeRepo('mvmark-broken-', 'vault: [unclosed\n');
    repoNone = makeRepo('mvmark-none-');
    repoA = makeRepo('mvmark-a-', 'vault: clientA\n');
    repoAShared = makeRepo('mvmark-ashared-', 'vault: clientA\nshare_global: true\n');
  });

  afterEach(() => {
    db.close();
    index.cleanup();
    globalVault.cleanup();
    clientA.cleanup();
    clientB.cleanup();
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  describe('the human CLI search', () => {
    it('an unknown vault in the marker reads NOTHING, never the config default vault', async () => {
      const config = configFor(repoTypo);
      expect(config.markerBroken).toBe(true);
      // No vault at all: the shared vault needs an invitation, and a marker that
      // names a vault nobody configured cannot give one.
      expect(resolveSearchVault(config, undefined)).toBeNull();

      expect(await searchFrom(repoTypo)).toEqual([]);
    });

    it('a malformed marker reads nothing too', async () => {
      const config = configFor(repoBroken);
      expect(config.markerBroken).toBe(true);
      expect(resolveSearchVault(config, undefined)).toBeNull();

      expect(await searchFrom(repoBroken)).toEqual([]);
    });

    it('no marker at all is unchanged: the config default vault', async () => {
      // The regression guard for the single-vault setup. In that setup the config
      // default IS 'global', so such a person sees no change at all. It is also
      // the proof that the two empty cases above closed something: the SAME query
      // from a repo with no marker does return the default vault.
      const config = configFor(repoNone);
      expect(config.markerBroken).toBeUndefined();
      expect(config.markerWarning).toBeUndefined();
      expect(resolveSearchVault(config, undefined)).toBe('clientB');

      const hits = await searchFrom(repoNone);
      expect(hints(hits).some((h) => h.startsWith('clientB:'))).toBe(true);
      expect(hints(hits).some((h) => h.startsWith('clientA:'))).toBe(false);
    });

    it('a valid marker reads its own vault ALONE, with no shared vault', async () => {
      const config = configFor(repoA);
      expect(config.defaultVault).toBe('clientA');
      expect(config.markerBroken).toBeUndefined();
      expect(config.shareGlobal).toBe(false);

      const hits = await searchFrom(repoA);
      expect(hits.length).toBeGreaterThan(0);
      expect(vaultsOf(hits)).toEqual(['clientA']);
    });

    it('share_global: true in the marker adds the shared vault, and only that one', async () => {
      const config = configFor(repoAShared);
      expect(config.defaultVault).toBe('clientA');
      expect(config.shareGlobal).toBe(true);

      const hits = await searchFrom(repoAShared);
      expect(hints(hits).some((h) => h.startsWith('clientA:'))).toBe(true);
      expect(hints(hits).some((h) => h.startsWith('global:'))).toBe(true);
      expect(hints(hits).some((h) => h.startsWith('clientB:'))).toBe(false);
    });

    it('the human can still widen on purpose with --vault', () => {
      // Fail-closed applies to the ambient answer only. A person typing at their
      // own terminal keeps the escape hatch, even in the broken-marker repo.
      const config = configFor(repoTypo);
      expect(resolveSearchVault(config, 'all')).toBe('all');
      expect(readableVaults(config, 'all')).toBeUndefined();
      expect(readableVaults(config, resolveSearchVault(config, 'clientB'))).toEqual(['clientB']);
    });
  });

  describe('the MCP proxy', () => {
    /**
     * Registers the tools against fakes and returns the params the proxy sent.
     * `offline: true` drops the daemon client, so the tool runs the proxy's own
     * read-only fallback and the real refusal is observable in the envelope.
     */
    function proxy(cwd: string, offline = false) {
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
          return Promise.resolve({ query_kind: 'natural', hits: [] });
        },
        close: () => { /* nothing to close in the fake */ },
      };
      const deps: ToolDeps = {
        getConfig: () => configFor(cwd),
        getDb: () => db,
        client: offline ? undefined : fakeClient as unknown as ToolDeps['client'],
      };
      registerTools(fakeServer as unknown as Parameters<typeof registerTools>[0], deps);
      return { handlers, get captured() { return captured; } };
    }

    it('stamps "no vault" on a search from a repo whose marker names an unknown vault', async () => {
      const ctx = proxy(repoTypo);
      await ctx.handlers.get('memory_search')!({ query: SHARED_QUERY });
      // null, not a vault name: the daemon turns it into an empty readable set.
      expect(ctx.captured?.params['vault']).toBeNull();
      expect(ctx.captured?.params['share_global']).toBe(false);
    });

    it('stamps "no vault" on a search from a repo with a malformed marker', async () => {
      const ctx = proxy(repoBroken);
      await ctx.handlers.get('memory_search')!({ query: SHARED_QUERY });
      expect(ctx.captured?.params['vault']).toBeNull();
    });

    it('still stamps the real vault when the marker is valid, and the default when there is none', async () => {
      const valid = proxy(repoA);
      await valid.handlers.get('memory_search')!({ query: SHARED_QUERY });
      expect(valid.captured?.params['vault']).toBe('clientA');
      expect(valid.captured?.params['share_global']).toBe(false);

      const none = proxy(repoNone);
      await none.handlers.get('memory_search')!({ query: SHARED_QUERY });
      expect(none.captured?.params['vault']).toBe('clientB');
    });

    it('passes the share_global opt-in through, and an agent cannot set it itself', async () => {
      const shared = proxy(repoAShared);
      await shared.handlers.get('memory_search')!({ query: SHARED_QUERY });
      expect(shared.captured?.params['vault']).toBe('clientA');
      expect(shared.captured?.params['share_global']).toBe(true);

      // The agent claims the opt-in from a repo that never asked for it. The
      // proxy writes the resolved scope LAST, so the claim is overwritten.
      const smuggle = proxy(repoA);
      await smuggle.handlers.get('memory_search')!({ query: SHARED_QUERY, share_global: true, vault: 'global' });
      expect(smuggle.captured?.params['share_global']).toBe(false);
      expect(smuggle.captured?.params['vault']).toBe('clientA');
    });

    it('memory_get of the project file is refused under a broken marker instead of opening another vault', async () => {
      // memory_get reads the curated layer, so it is scoped like a search. With
      // a marker we cannot honour, file:'project' is refused with the dedicated
      // VAULT_UNRESOLVED code, rather than opening the other client's
      // PROJECT.md. The hint names the marker file so the human can fix it.
      const offline = proxy(repoTypo, true);
      const res = await offline.handlers.get('memory_get')!({ file: 'project' }) as { content: Array<{ text: string }> };
      const body = JSON.parse(res.content[0]!.text) as { ok: boolean; error?: { code: string; hint: string } };
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe('VAULT_UNRESOLVED');
      expect(body.error?.hint).toContain('.memory.yml');
      expect(body.error?.hint).toContain('clientTYPO');
      // And nothing about the other client's vault leaks into the refusal.
      expect(JSON.stringify(body)).not.toContain('clientB');

      // With a valid marker the very same call reads that client's own file.
      const valid = proxy(repoA, true);
      const okRes = await valid.handlers.get('memory_get')!({ file: 'project' }) as { content: Array<{ text: string }> };
      const okBody = JSON.parse(okRes.content[0]!.text) as { ok: boolean; data?: { path_hint: string } };
      expect(okBody.ok).toBe(true);
      expect(okBody.data?.path_hint).toBe('clientA:PROJECT.md');

      // With a live daemon the refusal happens in the proxy, so the request
      // never leaves at all: the daemon is shared and its own config cannot see
      // that THIS caller's marker is broken, so it could not refuse for us.
      const online = proxy(repoTypo);
      const onlineRes = await online.handlers.get('memory_get')!({ file: 'project' }) as { content: Array<{ text: string }> };
      expect(online.captured).toBeUndefined();
      expect((JSON.parse(onlineRes.content[0]!.text) as { error?: { code: string } }).error?.code)
        .toBe('VAULT_UNRESOLVED');
    });
  });

  describe('the daemon session resolver', () => {
    // The daemon resolves the session's vault from the cwd the hook sends, so it
    // must apply the same four-way rule with its own config in hand.
    const daemonConfig = (): MemoryConfig => configFor(repoNone);

    it('an unknown vault in the marker resolves to no vault at all', () => {
      expect(resolveSessionVault(daemonConfig(), repoTypo)).toBeNull();
    });

    it('a malformed marker resolves to no vault at all', () => {
      expect(resolveSessionVault(daemonConfig(), repoBroken)).toBeNull();
    });

    it('no marker keeps the config default, and a valid marker keeps its own vault', () => {
      expect(resolveSessionVault(daemonConfig(), repoNone)).toBe('clientB');
      expect(resolveSessionVault(daemonConfig(), repoA)).toBe('clientA');
    });

    it('the sharing opt-in travels with the session scope', () => {
      expect(resolveSessionScope(daemonConfig(), repoA)).toMatchObject({ vault: 'clientA', shareGlobal: false });
      expect(resolveSessionScope(daemonConfig(), repoAShared)).toMatchObject({ vault: 'clientA', shareGlobal: true });
    });
  });

  describe('capture triage context (this text leaves the machine)', () => {
    /** A fake transport that records the body instead of sending it to OpenRouter. */
    function capturingChat(): { chat: ChatFn; body: () => string } {
      let seen: unknown;
      const chat: ChatFn = async (payload) => {
        seen = payload;
        return { choices: [{ message: { tool_calls: [{ function: { arguments: '{"nothing_to_save":true,"items":[]}' } }] } }] };
      };
      // '' means the transport was never called, which is how a skipped pass
      // shows up: no prompt was built, so nothing left the machine.
      return { chat, body: () => (seen === undefined ? '' : JSON.stringify(seen)) };
    }

    /** Runs one capture pass for a session in `cwd` and returns the outbound body. */
    async function triageBodyFor(sessionId: string, cwd: string | undefined): Promise<string> {
      const transcript = path.join(makeDir('mvmark-transcript-'), 'transcript.jsonl');
      fs.writeFileSync(transcript, JSON.stringify({
        type: 'user', uuid: `${sessionId}-u1`,
        message: { role: 'user', content: 'I prefer squash merges on the main branch' },
      }) + '\n', 'utf8');

      const { chat, body } = capturingChat();
      const capture = new CaptureManager({
        db,
        // The daemon default is clientB: the pass must not use it just because
        // the daemon happens to have been started there.
        config: { ...configFor(repoNone), openrouter: { apiKey: 'unused-with-fake', model: 'fake' } },
        log: silent,
        chat,
      });
      await capture.runPass(sessionId, transcript, cwd);
      return body();
    }

    it('a session in clientA repo sends clientA context ALONE, never clientB or the shared vault', async () => {
      const sent = await triageBodyFor('cap-a', repoA);
      expect(sent).toContain('ALPHA_CURATED_MARKER');
      expect(sent).not.toContain('GLOBAL_MARKER');
      expect(sent).not.toContain('BETA_CURATED_MARKER');
    });

    it('a session in a repo with share_global also sends the shared context', async () => {
      const sent = await triageBodyFor('cap-ashared', repoAShared);
      expect(sent).toContain('ALPHA_CURATED_MARKER');
      expect(sent).toContain('GLOBAL_MARKER');
      expect(sent).not.toContain('BETA_CURATED_MARKER');
    });

    it('a session whose marker cannot be honoured sends nothing at all', async () => {
      // Not even the shared vault: it needs an invitation this repo cannot give.
      // The whole pass is skipped, so the fake transport is never called.
      const sent = await triageBodyFor('cap-typo', repoTypo);
      expect(sent).toBe('');
    });

    it('a session with no cwd at all sends nothing either', async () => {
      // An older hook sends no cwd. We cannot tell whose repo this is, so the
      // pass refuses rather than guess a vault.
      const sent = await triageBodyFor('cap-nocwd', undefined);
      expect(sent).toBe('');
    });

    it('a session in a repo with no marker still gets the default vault context', async () => {
      // Regression guard: the normal single-vault user keeps their context.
      const sent = await triageBodyFor('cap-none', repoNone);
      expect(sent).toContain('BETA_CURATED_MARKER');
      expect(sent).not.toContain('ALPHA_CURATED_MARKER');
    });
  });
});
