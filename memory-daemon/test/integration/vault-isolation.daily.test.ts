import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { startDaemon, type DaemonStart } from '../../src/daemon/main.js';
import { DaemonClient } from '../../src/mcp/client.js';
import { loadConfig, type MemoryConfig } from '../../src/core/config.js';
import { registerTools, type ToolDeps } from '../../src/mcp/tools.js';
import { cmdShow, type CliCtx } from '../../src/cli/memory.js';
import { readWriteLog, type WriteLogEntry } from '../../src/core/write-log.js';
import { makeTmpVault, makeTmpIndexDir, type TmpVault } from '../helpers/tmp-vault.js';

/**
 * The daily log follows the SESSION's vault.
 *
 * `daily_append` used to write into `global/daily/` whatever repo the caller ran
 * in, and every caller may read `global`. The agent guide points agents at this
 * tool for anything taken from a meeting, a document or a tool result, which is
 * exactly the content most likely to belong to a client, so the one shared
 * destination undid the isolation for the most sensitive text an agent writes on
 * purpose. These cases pin the destination for all three marker states, prove
 * that the file, the re-index and the write log agree on one vault, and prove
 * the content gates still fire at the new destination.
 */

const silent = pino({ level: 'silent' });

const VAULT_FILES = { 'MEMORY.md': '# MEMORY\n\n## Decisions <!-- auto -->\n\n- seed\n' };

/** The phrase that must stay inside one vault. Distinctive on purpose. */
const CLIENT_PHRASE = 'pineapple ledger handover';
/** A secret in a day line: it must be refused wherever the line would land. */
const SECRET = 'api_key = xK9mQ2vL8pR4tW7zZZ';
/** The denylist term for this file. It appears in no other case here. */
const DENIED_TERM = 'zephyrclient';

const today = (): string => new Date().toISOString().slice(0, 10);

describe('the daily log follows the session vault', () => {
  let savedEnv: NodeJS.ProcessEnv;
  const tmpDirs: string[] = [];
  let globalVault: TmpVault;
  let acme: TmpVault;
  let other: TmpVault;
  let index: ReturnType<typeof makeTmpIndexDir>;
  let configPath: string;
  let repoAcme: string;
  let repoNone: string;
  let repoTypo: string;
  let daemon: DaemonStart | undefined;
  let pipePath: string;
  const clients: DaemonClient[] = [];

  const makeDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  };

  /** A repo folder holding exactly this `.memory.yml` (undefined = no marker). */
  const makeRepo = (prefix: string, marker?: string): string => {
    const repo = makeDir(prefix);
    if (marker !== undefined) fs.writeFileSync(path.join(repo, '.memory.yml'), marker, 'utf8');
    return repo;
  };

  /** The config a caller standing in `cwd` sees, loaded the way the proxy loads it. */
  const configFor = (cwd: string): MemoryConfig => loadConfig({ configPath, cwd });

  const newClient = (): DaemonClient => {
    const c = new DaemonClient({ pipePath, spawnCommand: false });
    clients.push(c);
    return c;
  };

  const dailyFile = (vault: TmpVault): string => path.join(vault.root, 'daily', `${today()}.md`);
  const readDaily = (vault: TmpVault): string =>
    fs.existsSync(dailyFile(vault)) ? fs.readFileSync(dailyFile(vault), 'utf8') : '';

  type Envelope = { ok: boolean; data?: Record<string, unknown>; error?: { code: string; hint: string } };
  const envelopeOf = (res: unknown): Envelope =>
    JSON.parse((res as { content: Array<{ text: string }> }).content[0]!.text) as Envelope;

  /**
   * The real MCP proxy for a caller standing in `cwd`, wired to the real daemon.
   * The whole point of these cases is the proxy-resolves / daemon-writes pair, so
   * nothing between the tool call and the file on disk is faked.
   */
  function proxyIn(cwd: string): (args: Record<string, unknown>) => Promise<Envelope> {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const fakeServer = {
      registerTool: (name: string, _cfg: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
        handlers.set(name, handler);
      },
    };
    const deps: ToolDeps = {
      getConfig: () => configFor(cwd),
      getDb: () => { throw new Error('these cases never take the offline read path'); },
      client: newClient(),
    };
    registerTools(fakeServer as unknown as Parameters<typeof registerTools>[0], deps);
    return async (args) => envelopeOf(await handlers.get('daily_append')!(args));
  }

  /** A CLI ctx standing in `cwd`, talking to the booted daemon. */
  function mkCtx(cwd: string): { ctx: CliCtx; out: string[] } {
    const out: string[] = [];
    const ctx: CliCtx = {
      config: configFor(cwd),
      writeClient: () => newClient(),
      readClient: () => newClient(),
      io: { out: (s) => out.push(s), err: () => undefined, isTTY: false, confirm: undefined },
      indexRootDir: index.root,
      cwd,
    };
    return { ctx, out };
  }

  beforeEach(async () => {
    savedEnv = { ...process.env };
    delete process.env['MEMORY_CONFIG'];
    delete process.env['MEMORY_REPO_CONFIG'];
    delete process.env['OPENROUTER_API_KEY'];
    for (const k of Object.keys(process.env)) {
      if (/^MEMORY_VAULT_/.test(k) || k === 'MEMORY_DEFAULT_VAULT') delete process.env[k];
    }
    // The denylist lives beside the app data, so pointing the app data dir at a
    // temp folder is enough to give this file its own list.
    const appData = makeDir('mvdaily-appdata-');
    process.env['MEMORY_APPDATA_DIR'] = appData;
    fs.writeFileSync(path.join(appData, 'denylist-terms.txt'), `${DENIED_TERM}\n`, 'utf8');

    globalVault = makeTmpVault(VAULT_FILES, { eol: 'lf' });
    acme = makeTmpVault(VAULT_FILES, { eol: 'lf' });
    other = makeTmpVault(VAULT_FILES, { eol: 'lf' });
    index = makeTmpIndexDir();

    // default_vault is 'other' on purpose: it is the vault a wrong fallback
    // would reach, so any misroute shows up as an 'other' write.
    configPath = path.join(makeDir('mvdaily-cfg-'), 'config.local.yml');
    fs.writeFileSync(configPath, [
      'vaults:',
      `  global: ${JSON.stringify(globalVault.root)}`,
      `  acme: ${JSON.stringify(acme.root)}`,
      `  other: ${JSON.stringify(other.root)}`,
      'default_vault: other',
      '',
    ].join('\n'), 'utf8');

    repoAcme = makeRepo('mvdaily-acme-', 'vault: acme\n');
    repoNone = makeRepo('mvdaily-none-');
    repoTypo = makeRepo('mvdaily-typo-', 'vault: nosuchvault\n');

    pipePath = process.platform === 'win32'
      ? `\\\\.\\pipe\\memory-vault.daily.${crypto.randomBytes(6).toString('hex')}`
      : path.join(os.tmpdir(), `mv-daily-${crypto.randomBytes(6).toString('hex')}.sock`);
    // The daemon has NO cwd, exactly like the real one: its own default vault is
    // the vault of whatever repo started it, so it cannot resolve for a caller.
    daemon = await startDaemon({
      pipePath, indexRootDir: index.root, watch: false, embedder: null,
      reconcileIntervalMs: 3_600_000, log: silent,
      config: loadConfig({ configPath }),
    });
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    if (daemon && !daemon.alreadyRunning) await daemon.close();
    daemon = undefined;
    index.cleanup();
    globalVault.cleanup();
    acme.cleanup();
    other.cleanup();
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  describe('where the day line lands', () => {
    it('a repo marked "vault: acme" writes the day line into acme, and no other vault can read it', async () => {
      const res = await proxyIn(repoAcme)({ text: `the ${CLIENT_PHRASE} was agreed today`, kind: 'decision' });
      expect(res.ok).toBe(true);
      expect(res.data?.['path_hint']).toBe(`acme:daily/${today()}.md`);

      // The file, and only that file.
      expect(readDaily(acme)).toContain(CLIENT_PHRASE);
      expect(readDaily(globalVault)).toBe('');
      expect(readDaily(other)).toBe('');
      expect(fs.existsSync(path.join(acme.root, 'daily'))).toBe(true);

      // No reindex call: runDaily indexes with the target vault's context, so the
      // line is searchable at once from acme and never from another vault.
      const search = newClient();
      const fromOther = await search.request('search', { query: CLIENT_PHRASE, k: 10, vault: 'other' });
      expect(fromOther.hits.some((h) => h.path_hint.startsWith('acme:'))).toBe(false);
      expect(JSON.stringify(fromOther.hits)).not.toContain('pineapple');

      const fromAcme = await search.request('search', { query: CLIENT_PHRASE, k: 10, vault: 'acme' });
      expect(fromAcme.hits.some((h) => h.path_hint === `acme:daily/${today()}.md`)).toBe(true);
    });

    it('a repo with no marker still writes into the config default vault', async () => {
      const res = await proxyIn(repoNone)({ text: 'no marker keeps the configured default' });
      expect(res.ok).toBe(true);
      // 'other' is the config default here. In a normal single-vault setup that
      // default is 'global', so this is the regression guard for that setup too.
      expect(res.data?.['path_hint']).toBe(`other:daily/${today()}.md`);
      expect(readDaily(other)).toContain('no marker keeps the configured default');
      expect(readDaily(acme)).toBe('');
      expect(readDaily(globalVault)).toBe('');
    });

    it('a repo whose marker cannot be honoured is refused, and writes nowhere', async () => {
      // The shared vault used to catch this line. It cannot any more: it is a
      // private vault now, and a repo that cannot name its own vault has not
      // invited anyone in. So the write is refused instead of parked somewhere.
      const res = await proxyIn(repoTypo)({ text: 'a broken marker must not pick a client vault' });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('VAULT_UNRESOLVED');
      expect(readDaily(globalVault)).toBe('');
      expect(readDaily(acme)).toBe('');
      expect(readDaily(other)).toBe('');
    });

    it('a request that carries no vault at all is refused, never routed to the daemon default', async () => {
      // The "no cwd" case: an older client, or any caller that could not resolve
      // a vault. The daemon must not fall back to its own default ('other'),
      // which in a multi-vault setup is another tenant's vault, and it must not
      // fall back to the shared vault either.
      await expect(newClient().request('daily', { text: 'a caller with no vault is refused' }))
        .rejects.toMatchObject({ code: 'VAULT_UNRESOLVED' });
      for (const v of [globalVault, acme, other]) expect(readDaily(v)).toBe('');
    });

    it('a vault name that is no longer configured is refused too', async () => {
      // The one race the client cannot cover: a vault removed from the config
      // between the resolve and the write. Fail closed, never guess.
      await expect(newClient().request('daily', { text: 'a removed vault is refused', vault: 'goneaway' }))
        .rejects.toMatchObject({ code: 'VAULT_UNRESOLVED' });
      for (const v of [globalVault, acme, other]) expect(readDaily(v)).toBe('');
    });
  });

  describe('the file, the index and the audit trail agree', () => {
    it('the write-log entry records the same vault the file was written to', async () => {
      await proxyIn(repoAcme)({ text: `audit follows the ${CLIENT_PHRASE}` });

      // The durable log lives under the vault that was changed, so reading acme's
      // own log proves both halves: the right vault name in the right file.
      const inAcme = readWriteLog([acme.root], 20).filter((e: WriteLogEntry) => e.op === 'daily_append');
      expect(inAcme.length).toBe(1);
      expect(inAcme[0]!.vault).toBe('acme');
      expect(inAcme[0]!.path).toBe(`daily/${today()}.md`);

      // Nothing was audited against a vault that never held the line.
      const elsewhere = readWriteLog([globalVault.root, other.root], 20)
        .filter((e: WriteLogEntry) => e.op === 'daily_append');
      expect(elsewhere).toEqual([]);
    });

    it('the search index attributes the line to the same vault as well', async () => {
      await proxyIn(repoAcme)({ text: `the index follows the ${CLIENT_PHRASE} too` });
      const hits = (await newClient().request('search', { query: CLIENT_PHRASE, k: 10, vault: 'acme' })).hits;
      const day = hits.find((h) => h.path_hint.endsWith(`daily/${today()}.md`));
      expect(day?.path_hint).toBe(`acme:daily/${today()}.md`);
    });
  });

  describe('the content gates still fire at the new destination', () => {
    it('the secret scan blocks a secret in a day line bound for a client vault', async () => {
      const res = await proxyIn(repoAcme)({ text: `deploy key for the client: ${SECRET}` });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('SECRET_BLOCKED');
      // Nothing was written anywhere, and no daily folder was created for it.
      expect(fs.existsSync(path.join(acme.root, 'daily'))).toBe(false);
      expect(readDaily(globalVault)).toBe('');
    });

    it('the client denylist now blocks a day line too, wherever it would land', async () => {
      // Without this gate `daily_append` was the way around the denylist: a term
      // memory_add refuses could be parked in the day file with the next call.
      const inClient = await proxyIn(repoAcme)({ text: `we met ${DENIED_TERM} about the migration` });
      expect(inClient.ok).toBe(false);
      expect(inClient.error?.code).toBe('DENYLIST_BLOCKED');

      const inGlobal = await proxyIn(repoNone)({ text: `${DENIED_TERM} again, from an unmarked repo` });
      expect(inGlobal.ok).toBe(false);
      expect(inGlobal.error?.code).toBe('DENYLIST_BLOCKED');

      expect(readDaily(acme)).toBe('');
      expect(readDaily(other)).toBe('');
      expect(readDaily(globalVault)).toBe('');
    });

    it('a clean line in the same repo still goes through, so the gates are not blanket refusals', async () => {
      const res = await proxyIn(repoAcme)({ text: 'the migration window closes on Friday' });
      expect(res.ok).toBe(true);
      expect(readDaily(acme)).toContain('the migration window closes on Friday');
    });
  });

  describe('memory show reports the caller\'s own vault', () => {
    it('counts the client vault\'s transcripts and day files instead of reporting zero', async () => {
      // A transcript where capture would put it for a session in this repo.
      fs.mkdirSync(path.join(acme.root, 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(acme.root, 'sessions', '2026-07-25-abcd1234.md'), '# Session\n', 'utf8');
      await proxyIn(repoAcme)({ text: `day one of the ${CLIENT_PHRASE}` });

      const { ctx, out } = mkCtx(repoAcme);
      await cmdShow(['--all'], ctx);
      const text = out.join('\n');

      // Each count names its vault, so none of them can be read against another.
      // Only acme is reported: this repo did not ask for the shared vault.
      expect(text).toMatch(/sessions\s+acme\s+1 transcript file\(s\)/);
      expect(text).toMatch(/daily\s+acme\s+1 day file\(s\), 1 entries/);
      expect(text).not.toMatch(/sessions\s+global\s/);
      // --all still lists the file names it counted.
      expect(text).toContain('2026-07-25-abcd1234.md');
    });

    it('a repo with share_global reports the shared vault as well', async () => {
      const repoShared = makeRepo('mvdaily-shared-', 'vault: acme\nshare_global: true\n');
      const { ctx, out } = mkCtx(repoShared);
      await cmdShow([], ctx);
      const text = out.join('\n');
      expect(text).toMatch(/sessions\s+acme\s+0 transcript file\(s\)/);
      expect(text).toMatch(/sessions\s+global\s+0 transcript file\(s\)/);
      expect(text).not.toContain('other');
    });

    it('an unmarked repo reports only its own vault, so a single-vault setup stays one line per layer', async () => {
      const { ctx, out } = mkCtx(repoNone);
      await cmdShow([], ctx);
      const text = out.join('\n');
      // 'other' is this repo's vault (the config default); acme is not readable
      // from here and must not appear at all.
      expect(text).toMatch(/sessions\s+other\s+0 transcript file\(s\)/);
      expect(text).not.toContain('acme');
    });
  });
});
