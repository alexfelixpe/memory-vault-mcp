#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import Database from 'better-sqlite3';
import { loadConfig, printConfigWarning, type MemoryConfig } from '../core/config.js';
import { readableVaults, ambientReadVault, withScopeNotice, ALL_VAULTS } from '../core/vault-scope.js';
import { dataDir, indexRootDir } from '../core/paths.js';
import { pipeName } from '../core/ipc-address.js';
import { openIndexDb, IndexUnavailableError, readCurrentGeneration } from '../index/db.js';
import { reconcileVault } from '../index/reconcile.js';
import { loadRegistryVocab } from '../core/identifiers.js';
import { buildSearchContext } from '../index/context.js';
import { memorySearch, QueryTooShortError, type SearchRequest } from '../index/search/search.js';
import type { Scope } from '../index/search/lexical.js';
import { DaemonClient, DaemonUnavailableError, RpcError } from '../mcp/client.js';
import {
  runGet, resolveMemoryFile, resolveTargetVault, ToolError,
  type MemoryFile, type PurgeSessionsData,
} from '../daemon/write-pipeline.js';
import { readWriteLog } from '../core/write-log.js';
import { normalizeForMatch } from '../core/text/normalize.js';
import { doctorEmbeddings, configDoctorLine, type DoctorDeps } from './doctor.js';
import { cmdInit } from './init.js';
import { cmdVault, VaultCommandError } from './vault.js';
import { runUninstall, resolveUninstallTargets } from './uninstall.js';
import { runReset, defaultResetIndexDir } from './reset.js';
import { detectClaudeCode, type UnregisterResult } from './hooks-register.js';

/**
 * `memory` CLI. Increment 2: index and status prefer the daemon when it is
 * alive (always-fresh index, a single writer); without a daemon, they
 * operate directly on the database as in Increment 1.
 */

const USAGE = `usage:
  memory init [options]                  set up the system in one command
      --vault <path>   vault folder (else prompt on a TTY, else <home>/memory-vault)
      --name <name>    config vault name (default global)
      --force          replace an existing config file (vaults already in it are kept)
      --hooks|--no-hooks   register (or skip) the Claude Code hooks; asks on a TTY
      --settings <path>    settings.json for the hooks (default <home>/.claude/settings.json)
  memory index [--vault <name>]          reindex (via daemon if it is alive)
  memory vault list                      show the configured vaults and which one is used here
  memory vault add <name> <path>         add a vault, keeping the ones already configured
  memory vault seed <name>               create the curated files a registered vault is missing
  memory search "<query>" [options]      search the personal history
      --k <n>          how many results (default 6)
      --scope <s>      all|curated|reservoir|meetings|daily
      --vault <name>   search one vault (default: this folder's vault + global)
      --vault all      search every vault at once
      --browse         list by recency instead of searching
      --json           raw JSON output
  memory status                          state of the index and the daemon
  memory show [--all] [--json]           show everything remembered (curated + a count of every other layer)
  memory get <file> [section] [--hashes] [--json]
                                         read a curated file (file = user|memory|project)
  memory add <file> <section> "<text>"   add a fact you are telling it directly
  memory edit <file> <section> --match "<old>" --text "<new>"
                                         replace an existing curated entry
  memory forget "<text>" [--yes] [--purge-backups] [--purge-sessions] [--json]
                                         remove a curated entry (then prints what it does NOT reach)
      --purge-sessions  also scrub matching lines from vault/sessions/ transcripts (explicit; git history is out of scope)
  memory log [--limit <n>] [--json]      audit trail: who/what wrote to memory, and when
  memory snapshot [--out <file>]         export the freezable curated briefing
  memory backup                          back up the vault now: commit it to local git
  memory daemon start|stop|ping          control memoryd
  memory doctor                          environment diagnostics
  memory reset [--all] [--yes]           clear the rebuildable SQLite index
      keeps curated USER/MEMORY/PROJECT and vault notes; index re-derives from the vault
      --all            also empty the curated files (strong confirmation)
      --yes            skip the confirmation prompt
  memory uninstall [options]             remove the system; keep your vault by default
      --purge-vault    also delete the vault(s) and backups (strong confirmation)
      --purge-repo-config   also delete the repo-root config.local.yml
      --settings <path>     settings.json to unregister the hooks from
      --yes            skip the confirmation prompt
`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/**
 * The package version, for `memory --version`. Reads package.json two levels up
 * from this file — the same relative depth in both src/cli/ and dist/cli/. A
 * read failure degrades to 'unknown' rather than crashing the CLI.
 */
function readVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The one-line "what leaves my machine?" answer, shown in both `doctor` and
 * `status`. Capture (triage via OpenRouter) is the only feature that sends data
 * off the machine; the key value is never printed. This makes egress visible
 * where a human actually checks, not only in a docs diagram.
 */
export function captureEgressLine(
  captureOn: boolean,
  triage?: { backend: 'openrouter' | 'claude-cli'; model: string } | undefined,
): string {
  if (!captureOn) return 'Capture: OFF -- no session text leaves this machine.';
  return triage?.backend === 'claude-cli'
    ? 'Capture: ON -- session snippets are sent to Anthropic through the local Claude CLI, on your own Claude account, for triage.'
    : 'Capture: ON -- session snippets are sent to OpenRouter (openrouter.ai, a third-party LLM API in the US) for triage.';
}

/** The triage config as this folder resolves it, or undefined when config fails. */
function localTriage(): { backend: 'openrouter' | 'claude-cli'; model: string } | undefined {
  try {
    return loadConfig({ cwd: process.cwd() }).triage;
  } catch {
    return undefined;
  }
}

/** Probe client: NEVER starts the daemon as a side effect of the CLI. */
function probeClient(): DaemonClient {
  return new DaemonClient({ spawnCommand: false, connectWindowMs: 500 });
}

async function cmdIndex(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { vault: { type: 'string' } }, allowPositionals: false });
  const config = loadConfig({ cwd: process.cwd() });
  if (values.vault && !config.vaults[values.vault]) {
    fail(`vault '${values.vault}' is not configured (${Object.keys(config.vaults).join(', ')})`);
  }

  // A live daemon indexes itself: a single writer on the database.
  const client = probeClient();
  try {
    const results = await client.request('reindex', { vault: values.vault });
    for (const [name, r] of Object.entries(results)) {
      console.log(
        `${name} (via daemon): ${r.scanned} scanned, ${r.indexed} indexed, ` +
        `${r.unchanged} unchanged, ${r.removed} removed, ${r.skipped.length} skipped, ${r.elapsedMs} ms`,
      );
    }
    return;
  } catch (e) {
    if (!(e instanceof DaemonUnavailableError)) throw e;
  } finally {
    client.close();
  }

  const targets = values.vault ? [values.vault] : Object.keys(config.vaults);
  const db = openIndexDb();
  try {
    for (const name of targets) {
      const root = config.vaults[name]!;
      if (!fs.existsSync(root)) {
        console.log(`${name}: root ${root} does not exist, skipping`);
        continue;
      }
      const result = reconcileVault({ db, vaultName: name, vaultRoot: root, vocab: loadRegistryVocab(root) });
      console.log(
        `${name}: ${result.scanned} files scanned, ${result.indexed} indexed, ` +
        `${result.unchanged} unchanged, ${result.removed} removed, ` +
        `${result.skipped.length} skipped, ${result.elapsedMs} ms`,
      );
      for (const s of result.skipped) console.log(`  skipped (not UTF-8): ${s}`);
    }
  } finally {
    db.close();
  }
}

/**
 * Resolves `--vault` for a human search, returning the vault name, or null when
 * this folder has none it may use. 'all' is the human's escape hatch across
 * every vault — trusted here for the same reason the CLI is exempt from the
 * injection scan, and unreachable from an agent (the MCP tool schema has no
 * vault field). An unknown name is refused loudly instead of quietly returning
 * nothing.
 *
 * With no flag the answer comes from ambientReadVault, not from the raw config
 * default: a repo whose `.memory.yml` cannot be honoured reads nothing at all,
 * so it returns null. A human who really wants another vault still says so with
 * --vault. Naming a vault explicitly does NOT bring the shared vault along; only
 * the repo marker's `share_global: true` does that.
 */
export function resolveSearchVault(config: MemoryConfig, given: string | undefined): string | null {
  if (given === undefined) return ambientReadVault(config) ?? null;
  if (given === ALL_VAULTS) return ALL_VAULTS;
  if (!config.vaults[given]) {
    throw new CliError(
      `vault '${given}' is not configured (${Object.keys(config.vaults).join(', ')}). `
      + `Use --vault all to search every vault, or add it with: memory vault add ${given} <path>`,
    );
  }
  return given;
}

async function cmdSearch(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      k: { type: 'string' },
      scope: { type: 'string' },
      vault: { type: 'string' },
      json: { type: 'boolean' },
      browse: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const query = positionals.join(' ').trim();
  if (!query && !values.browse) fail('provide the query: memory search "your question"' + `\n\n${USAGE}`);

  const config = loadConfig({ cwd: process.cwd() });
  // A marker naming an unknown vault changes which memory this search can see,
  // so the human must be told before they read the results.
  printConfigWarning(config);
  let vault: string | null;
  try {
    vault = resolveSearchVault(config, values.vault);
  } catch (e) {
    // One clean line, no stack: this is a typed flag, not a crash.
    fail(e instanceof Error ? e.message : String(e));
  }
  // The sharing flag travels beside the vault, exactly as the MCP proxy sends
  // it. It applies to the ambient scope only: an explicit --vault names one
  // vault and asks for nothing else.
  const shareGlobal = values.vault === undefined && config.shareGlobal === true;
  const req: SearchRequest = {
    query: query || 'browse',
    ...(values.k ? { k: Number(values.k) } : {}),
    ...(values.scope ? { scope: values.scope as Scope } : {}),
    ...(values.browse ? { mode: 'browse' as const } : {}),
    vault,
    share_global: shareGlobal,
  };

  // A live daemon has the vector channel (hybrid); direct on the database is lexical only.
  let res;
  const client = probeClient();
  try {
    res = await client.request('search', req);
  } catch (e) {
    if (!(e instanceof DaemonUnavailableError)) throw e;
  } finally {
    client.close();
  }

  let db;
  if (!res) {
    try {
      db = openIndexDb({ readonly: true });
    } catch (e) {
      if (e instanceof IndexUnavailableError) fail(e.message);
      throw e;
    }
  }

  try {
    // No daemon: the direct read applies the same readable set itself, so the
    // fallback path can never see more than the daemon path would.
    res ??= await memorySearch(
      buildSearchContext(db!, config, undefined, readableVaults(config, vault, shareGlobal)),
      req,
    );
    // Same advisory field the MCP proxy attaches, so a person reading --json
    // gets the same explanation the agent does. In human mode the fuller
    // printConfigWarning above already said it, so nothing is printed twice.
    res = withScopeNotice(config, res);

    if (values.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    // Lexical-only ranking; say so once so the human does not read a thinner
    // result set as "nothing matched". Distinguish the two causes: embeddings
    // turned OFF in config is permanent, a cold embedder is temporary. Saying
    // "warming up" when the feature is disabled would promise a state that never
    // arrives.
    if (res.degraded === 'lexical_only') {
      console.log(config.embeddings.enabled === false
        ? 'note: embeddings are disabled in config -- search is keyword-only.'
        : 'note: embedding model is still warming up -- results are keyword-only for now');
    }
    if (res.hits.length === 0) {
      console.log(`no result (${res.empty_reason ?? 'empty'})`);
      return;
    }
    for (const hit of res.hits) {
      const head = hit.heading ? `  ${hit.heading}` : '';
      console.log(`${hit.rank}. [${hit.channels.join(',')}] ${hit.path_hint}${head}`);
      console.log(`   ${hit.date ?? 'no date'} | trust: ${hit.trust}`);
      console.log(`   ${hit.snippet}`);
      console.log('');
    }
    if (res.cursor) console.log(`cursor for the next page: ${res.cursor}`);
  } catch (e) {
    if (e instanceof QueryTooShortError) fail(e.message);
    throw e;
  } finally {
    db?.close();
  }
}

async function cmdStatus(): Promise<void> {
  const client = probeClient();
  try {
    const s = await client.request('status');
    console.log(`daemon: alive (pid ${s.pid}, uptime ${Math.round(s.uptimeMs / 1000)} s)`);
    console.log(`  last reconcile: ${s.lastReconcileAt ? new Date(s.lastReconcileAt).toISOString() : 'has not run yet'}${s.reconciling ? ' (running now)' : ''}`);
    console.log(`  watcher queue: ${s.watcherQueueSize}`);
    console.log(`  embedder: ${s.embedderWarm ? 'warm' : 'cold (lexical search)'} | vectors: ${s.vectorSize} | backlog: ${s.embedBacklog}`);
    for (const f of s.files) console.log(`  ${f.vault}: ${f.count} files`);
    console.log(`  chunks: ${s.chunks}`);
    console.log(captureEgressLine(s.captureOn, localTriage()));
    if (s.captureNotice) console.log(`  WARNING: ${s.captureNotice}`);
    return;
  } catch (e) {
    if (!(e instanceof DaemonUnavailableError)) throw e;
    console.log('daemon: stopped (search works via direct read; write and watcher do not)');
  } finally {
    client.close();
  }

  const root = process.env['MEMORY_INDEX_DIR'] ?? indexRootDir();
  const gen = readCurrentGeneration(root);
  if (!gen) fail(`index does not exist at ${root}. Run: memory index`);
  console.log(`index: ${root} (${gen})`);

  const db = openIndexDb({ readonly: true });
  try {
    const files = db.prepare('SELECT vault, COUNT(*) AS n FROM files WHERE is_deleted = 0 GROUP BY vault').all() as Array<{ vault: string; n: number }>;
    const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
    for (const f of files) console.log(`  ${f.vault}: ${f.n} files`);
    console.log(`  chunks: ${chunks.n}`);
    const config = loadConfig({ cwd: process.cwd() });
    console.log(captureEgressLine(!!config.triage, config.triage));
    const last = db.prepare("SELECT at, detail FROM index_log WHERE action = 'reconcile' ORDER BY at DESC LIMIT 1").get() as { at: number; detail: string } | undefined;
    if (last) console.log(`  last reconcile: ${new Date(last.at).toISOString()} ${last.detail}`);
  } finally {
    db.close();
  }
}

async function cmdSnapshot(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { out: { type: 'string' } }, allowPositionals: false });
  // Platforms without hooks (Cursor, Claude Desktop) include this file
  // through their own mechanism (decision of 2026-07-21, briefing portability).
  const { buildSnapshotBody } = await import('../daemon/write-pipeline.js');
  const config = loadConfig({ cwd: process.cwd() });
  const body = buildSnapshotBody(config);
  if (values.out) {
    fs.writeFileSync(values.out, body + '\n', 'utf8');
    console.log(`briefing exported to ${values.out} (${[...body].length} chars)`);
  } else {
    console.log(body);
  }
}

async function cmdDaemon(args: string[]): Promise<void> {
  const action = args[0];
  if (action === 'start') {
    // The client itself starts the daemon on demand and waits for the ping.
    const client = new DaemonClient();
    try {
      const ping = await client.request('ping');
      console.log(`daemon up: pid ${ping.pid}, version ${ping.version}, pipe ${pipeName()}`);
    } finally {
      client.close();
    }
    return;
  }
  if (action === 'stop') {
    const client = probeClient();
    try {
      await client.request('shutdown');
      console.log('daemon stopped.');
    } catch (e) {
      if (e instanceof DaemonUnavailableError) console.log('daemon was already stopped.');
      else throw e;
    } finally {
      client.close();
    }
    return;
  }
  if (action === 'ping') {
    const client = probeClient();
    try {
      const ping = await client.request('ping');
      console.log(`pong: pid ${ping.pid}, uptime ${Math.round(ping.uptimeMs / 1000)} s, protocol v${ping.protocol}`);
    } catch (e) {
      if (e instanceof DaemonUnavailableError) fail('daemon stopped. Start it with: memory daemon start');
      throw e;
    } finally {
      client.close();
    }
    return;
  }
  fail(`invalid action '${action ?? ''}'.\n\n${USAGE}`);
}

async function cmdDoctor(deps: DoctorDeps = {}): Promise<void> {
  let ok = true;
  const check = (label: string, fn: () => string): void => {
    try {
      console.log(`ok    ${label}: ${fn()}`);
    } catch (e) {
      ok = false;
      console.log(`FAIL ${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  check('node', () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 22) throw new Error(`node ${process.versions.node}; the minimum is 22 (.nvmrc)`);
    return process.versions.node;
  });
  check('better-sqlite3 + fts5', () => {
    const db = new Database(':memory:');
    try {
      db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize=\"trigram remove_diacritics 1\")");
      return `sqlite ${(db.prepare('SELECT sqlite_version() v').get() as { v: string }).v}, fts5 with trigram`;
    } finally {
      db.close();
    }
  });
  check('config', () => {
    const config = loadConfig({ cwd: process.cwd() });
    return `default_vault=${config.defaultVault}; vaults: ${Object.entries(config.vaults).map(([n, p]) => `${n}=${p}${fs.existsSync(p) ? '' : ' (DOES NOT EXIST)'}`).join(', ')}`;
  });
  // Name the config file that actually wins, right after the config check.
  // loadConfig prefers a repo-root config.local.yml (and MEMORY_CONFIG) over the
  // OS-dir config, so this tells the user WHICH file the values above came from.
  console.log(configDoctorLine());
  check('index', () => {
    const root = process.env['MEMORY_INDEX_DIR'] ?? indexRootDir();
    const gen = readCurrentGeneration(root);
    return gen ? `${root} (${gen})` : `${root} (not created yet; run memory index)`;
  });
  check('daemon (dist)', () => {
    const daemonJs = fileURLToPath(new URL('../daemon/main.js', import.meta.url));
    if (!fs.existsSync(daemonJs) && daemonJs.includes(`${path.sep}dist${path.sep}`)) {
      throw new Error(`${daemonJs} does not exist; run npm run build`);
    }
    return `pipe ${pipeName()}`;
  });

  // Egress transparency: name the one feature that sends data off the machine,
  // right here where a human checks their install. Loud, and never the key. A
  // broken config (its own FAIL above) can't tell us the key, so treat it as OFF.
  let triage: ReturnType<typeof localTriage>;
  try {
    triage = loadConfig({ cwd: process.cwd() }).triage;
  } catch {
    // config failed to load (reported above); capture cannot run, so OFF.
  }
  console.log(captureEgressLine(!!triage, triage));

  // Embeddings: actually load the model and run one real inference. A failure
  // here is a WARN, not a FAIL — lexical search still works, so doctor reports
  // the degraded state and still exits 0. This is the check that catches the
  // top adoption risk: a missing model or unsupported onnxruntime silently
  // dropping hybrid search to lexical-only without telling the user. When
  // embeddings are disabled in config, this reports "disabled" and does NOT
  // download the model.
  const emb = await doctorEmbeddings(deps);
  for (const line of emb.lines) console.log(line);

  if (!ok) process.exit(1);
}

// ---------------------------------------------------------------------------
// Trust-and-control verbs: uninstall (remove the system, keep the memory) and
// reset (clear derived/captured state, keep curated memory). Both are
// destructive, so both stop the daemon first, print exactly what they touch,
// and refuse to run without a confirmation (a TTY prompt, or --yes). The
// filesystem work lives in pure workers (uninstall.ts / reset.ts) that take
// explicit paths, so the tests exercise the removal against temp dirs and the
// real setup is never at risk.
// ---------------------------------------------------------------------------

/** Best-effort daemon stop before deleting the index it may hold open. */
async function stopDaemonQuietly(): Promise<void> {
  const client = probeClient();
  try {
    await client.request('shutdown');
  } catch {
    // already stopped or unreachable: we are removing/clearing it anyway
  } finally {
    client.close();
  }
}

/** Reads one exact-phrase answer from a real terminal: a strong confirmation. */
async function promptExactPhrase(question: string, expected: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim() === expected;
  } finally {
    rl.close();
  }
}

/** One-line summary of what happened to the Claude Code hooks. */
function describeUnregister(h: UnregisterResult): string {
  switch (h.action) {
    case 'updated': return `unregistered from ${h.settingsPath} (events: ${h.removedEvents.join(', ')}; backup ${h.backupPath})`;
    case 'not_found': return `none of our hooks were present in ${h.settingsPath}`;
    case 'missing': return `no settings file at ${h.settingsPath}`;
  }
}

/** Vaults from config, or an empty map when the config is too broken to read. */
function vaultsOrEmpty(): Record<string, string> {
  try {
    return loadConfig({ cwd: process.cwd() }).vaults;
  } catch {
    return {};
  }
}

/** memory uninstall — remove the system footprint; keep the vault unless --purge-vault. */
async function cmdUninstall(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      yes: { type: 'boolean' },
      'purge-vault': { type: 'boolean' },
      'purge-repo-config': { type: 'boolean' },
      settings: { type: 'string' },
    },
    allowPositionals: false,
  });

  // A broken config still lets us remove the system footprint; we just have no
  // vault to keep or purge in that case.
  const vaults = vaultsOrEmpty();
  const targets = resolveUninstallTargets();
  const settingsPath = values.settings
    ?? process.env['MEMORY_CLAUDE_SETTINGS']
    ?? detectClaudeCode(process.cwd()).userSettings;
  const purgeVault = values['purge-vault'] === true;

  console.log('memory uninstall will REMOVE (all rebuildable):');
  console.log(`  - SQLite index: ${targets.indexDir}`);
  console.log(`  - auth token:   ${targets.tokenFile}`);
  console.log(`  - model cache:  ${targets.modelCache}`);
  console.log(`  - logs:         ${targets.logsDir}`);
  console.log(`  - config:       ${targets.configFile}`);
  if (values['purge-repo-config'] === true) console.log(`  - repo config:  ${targets.repoConfigFile}`);
  console.log(`  - Claude Code hooks in: ${settingsPath}`);
  if (purgeVault) {
    console.log('  - AND YOUR VAULT(S) -- your memory and its backups:');
    for (const [n, p] of Object.entries(vaults)) console.log(`      ${n}: ${p}`);
  } else {
    console.log('KEEPS your vault(s) (your memory). Pass --purge-vault to delete them too.');
    for (const [n, p] of Object.entries(vaults)) console.log(`  keep ${n}: ${p}`);
  }
  console.log('');

  if (!values.yes) {
    if (process.stdout.isTTY !== true) {
      fail('Refusing to uninstall without confirmation. Re-run with --yes (add --purge-vault to also delete the vault).');
    }
    const ok = purgeVault
      ? await promptExactPhrase('This DELETES your memory permanently. Type "delete my memory" to proceed: ', 'delete my memory')
      : await promptYesNo('Proceed with uninstall (vault kept)? [y/N] ');
    if (!ok) { console.log('aborted; nothing was removed.'); return; }
  }

  // Stop the daemon so nothing holds the index open while we delete it.
  await stopDaemonQuietly();

  const result = runUninstall({
    targets, vaults, settingsPath,
    purgeVault, purgeRepoConfig: values['purge-repo-config'] === true,
  });

  console.log('Removed:');
  for (const r of result.removed) {
    console.log(`  ${r.existed ? '[x]' : '[ ]'} ${r.label}: ${r.path}${r.existed ? '' : ' (was not present)'}`);
  }
  console.log(`  hooks: ${describeUnregister(result.hooks)}`);
  if (result.kept.length > 0) {
    console.log('Kept:');
    for (const k of result.kept) console.log(`  ${k.label}: ${k.path}`);
  }
  console.log('');
  console.log('One manual step: remove the memory MCP server from your agent config.');
  console.log('  Claude Code:  claude mcp remove memory   (or delete the "memory" entry under mcpServers).');
  console.log(`  Its entry pointed at: node ${result.mcpServerJs}`);
}

/** memory reset — clear captured/derived state; keep curated memory unless --all. */
async function cmdReset(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { yes: { type: 'boolean' }, all: { type: 'boolean' } },
    allowPositionals: false,
  });
  const all = values.all === true;

  // reset needs a real vault to clear from; a broken config is a hard error.
  let vaults: Record<string, string>;
  try {
    vaults = loadConfig({ cwd: process.cwd() }).vaults;
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  const indexDir = defaultResetIndexDir();

  console.log('memory reset will CLEAR (rebuildable):');
  console.log(`  - SQLite index:  ${indexDir}`);
  if (all) {
    console.log('  - AND empty the curated files (USER/MEMORY/PROJECT) in:');
    for (const [n, p] of Object.entries(vaults)) console.log(`      vault '${n}': ${p}`);
  } else {
    console.log('KEEPS your curated memory (USER/MEMORY/PROJECT) and all vault notes (daily/, sessions/, digests/).');
    console.log('The index re-derives from the vault on the next daemon start.');
  }
  console.log('');

  if (!values.yes) {
    if (process.stdout.isTTY !== true) {
      fail('Refusing to reset without confirmation. Re-run with --yes (add --all to also empty curated memory).');
    }
    const ok = all
      ? await promptExactPhrase('--all also EMPTIES your curated memory. Type "clear curated" to proceed: ', 'clear curated')
      : await promptYesNo('Proceed with reset (curated kept)? [y/N] ');
    if (!ok) { console.log('aborted; nothing was cleared.'); return; }
  }

  await stopDaemonQuietly();

  const result = runReset({ indexDir, vaults, all });
  console.log('Cleared:');
  for (const r of result.cleared) {
    console.log(`  ${r.existed ? '[x]' : '[ ]'} ${r.label}: ${r.path}${r.existed ? '' : ' (was not present)'}`);
  }
  if (result.curatedCleared.length > 0) {
    console.log('Emptied curated:');
    for (const c of result.curatedCleared) console.log(`  [x] ${c.label}: ${c.path}`);
  }
  if (result.curatedKept.length > 0) {
    console.log('Kept curated:');
    for (const k of result.curatedKept) console.log(`  ${k.label}: ${k.path}`);
  }
  console.log('');
  console.log('Next start of the daemon rebuilds the index from your vault.');
}

// ---------------------------------------------------------------------------
// Human memory-management verbs (get / add / edit / forget / show / log).
//
// A human must be able to create, fix, delete and see all of their own memory
// from the terminal, not only approve captured candidates. Every one of these
// commands talks to the SAME daemon the model does (the single writer), so the
// write pipeline is never re-implemented here. The section hashes the pipeline
// needs are fetched and passed internally: the human never sees or types one.
// ---------------------------------------------------------------------------

/** User-facing error in a new command: printed to stderr, exit 1, no stack. */
class CliError extends Error {}

/** Injectable side effects, so the commands are testable against a temp daemon. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** stdout is a real terminal: only then does `forget` prompt for confirmation. */
  isTTY: boolean;
  /** Interactive yes/no; absent in non-interactive contexts (tests, pipes). */
  confirm?: ((question: string) => Promise<boolean>) | undefined;
}

export interface CliCtx {
  config: MemoryConfig;
  /** Spawns the daemon if needed (writes require it). */
  writeClient(): DaemonClient;
  /** Probe only (never spawns); reads fall back to a direct disk read. */
  readClient(): DaemonClient;
  io: CliIo;
  /** Test override for the readonly index read in `memory log`. */
  indexRootDir?: string | undefined;
  /**
   * The folder this command runs in. The daemon resolves this repo's marker from
   * it, so a write lands in the vault of the repo the human is standing in, not
   * in the daemon's own default vault.
   */
  cwd?: string | undefined;
}

function defaultCtx(): CliCtx {
  const config = loadConfig({ cwd: process.cwd() });
  // A repo marker that could not be honoured changes what these commands can
  // read and refuses a project write. Say it here, once, so the human sees the
  // reason with the command output instead of finding it in a log later.
  printConfigWarning(config);
  return {
    config,
    writeClient: () => new DaemonClient(),
    readClient: () => probeClient(),
    io: {
      out: (line) => process.stdout.write(line + '\n'),
      err: (line) => process.stderr.write(line + '\n'),
      isTTY: process.stdout.isTTY === true,
      confirm: (question) => promptYesNo(question),
    },
    cwd: process.cwd(),
  };
}

/** Reads one y/N answer from a real terminal. */
async function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function parseFileArg(value: string | undefined): MemoryFile {
  if (value === 'user' || value === 'memory' || value === 'project') return value;
  throw new CliError(`file must be one of: user | memory | project (got '${value ?? ''}')`);
}

interface CuratedEntry { text: string; line: number; entry_hash: string }
interface CuratedSection { name: string; auto: boolean; section_hash: string; entries: CuratedEntry[] }
interface CuratedView {
  path_hint: string;
  trust: string;
  hash: { fileHash: string; sections: Record<string, string> };
  budget: { used_chars: number; limit_chars: number };
  sections: CuratedSection[];
}
interface MutateResult {
  path_hint: string;
  budget: { used_chars: number; limit_chars: number };
  applied: Array<Record<string, unknown>>;
  consolidated?: boolean;
}

/** True for the "this curated file does not exist" error, from either transport. */
function isFileNotFound(e: unknown): boolean {
  return (e instanceof ToolError || e instanceof RpcError) && e.code === 'FILE_NOT_FOUND';
}

/**
 * get params without an `undefined` section (exactOptionalPropertyTypes).
 *
 * The vault comes from resolveTargetVault, never from the raw config default: in
 * a repo whose `.memory.yml` cannot be honoured, that default is another
 * client's vault, so `memory get project` used to print that client's
 * PROJECT.md. It now refuses with VAULT_UNRESOLVED and names the file to fix.
 */
function getParams(ctx: CliCtx, file: MemoryFile, section?: string): {
  file: MemoryFile; vault: string; section?: string;
} {
  const params: { file: MemoryFile; vault: string; section?: string } = {
    file, vault: resolveTargetVault(ctx.config),
  };
  if (section) params.section = section;
  return params;
}

/**
 * Reads a curated file. Prefers the live daemon (always-fresh); with no daemon
 * it falls back to a direct disk read, exactly as memory_get does. A read never
 * needs the single writer, so it never spawns the daemon.
 */
async function getCurated(ctx: CliCtx, file: MemoryFile, section?: string): Promise<CuratedView> {
  const params = getParams(ctx, file, section);
  const client = ctx.readClient();
  try {
    return await client.request('get', params) as unknown as CuratedView;
  } catch (e) {
    if (!(e instanceof DaemonUnavailableError)) throw e;
    return runGet(ctx.config, params) as unknown as CuratedView;
  } finally {
    client.close();
  }
}

/** Same read but over an already-open write client (reuses one connection). */
async function getCuratedVia(client: DaemonClient, ctx: CliCtx, file: MemoryFile, section?: string): Promise<CuratedView> {
  return await client.request('get', getParams(ctx, file, section)) as unknown as CuratedView;
}

function renderCuratedView(ctx: CliCtx, view: CuratedView, opts: { hashes: boolean }): void {
  ctx.io.out(`${view.path_hint} (${view.trust}) — ${view.budget.used_chars}/${view.budget.limit_chars} chars`);
  for (const section of view.sections) {
    ctx.io.out('');
    ctx.io.out(`## ${section.name}${section.auto ? '  [auto — writable]' : '  [not auto — human-only]'}`);
    if (opts.hashes) ctx.io.out(`   section hash: ${section.section_hash}`);
    if (section.entries.length === 0) ctx.io.out('   (empty)');
    for (const entry of section.entries) {
      ctx.io.out(`  - ${entry.text}`);
      if (opts.hashes) ctx.io.out(`      entry hash: ${entry.entry_hash}`);
    }
  }
}

function printMutateResult(ctx: CliCtx, verb: string, text: string, res: MutateResult): void {
  ctx.io.out(`${verb}: ${res.path_hint}`);
  ctx.io.out(`  - ${text}`);
  ctx.io.out(
    `  budget: ${res.budget.used_chars}/${res.budget.limit_chars} chars` +
    (res.consolidated ? '  (older entries were auto-consolidated to fit)' : ''),
  );
}

/** memory get <file> [section] — read a curated file and its section hashes. */
export async function cmdGet(args: string[], ctx: CliCtx): Promise<void> {
  const { values, positionals } = parseArgs({
    args, options: { hashes: { type: 'boolean' }, json: { type: 'boolean' } }, allowPositionals: true,
  });
  const file = parseFileArg(positionals[0]);
  const section = positionals[1];
  const view = await getCurated(ctx, file, section);
  if (values.json) { ctx.io.out(JSON.stringify(view, null, 2)); return; }
  renderCuratedView(ctx, view, { hashes: values.hashes === true });
}

/** memory add <file> <section> "<text>" — the human states a fact directly. */
export async function cmdAdd(args: string[], ctx: CliCtx): Promise<void> {
  const { values, positionals } = parseArgs({ args, options: { json: { type: 'boolean' } }, allowPositionals: true });
  const file = parseFileArg(positionals[0]);
  const section = positionals[1];
  const text = positionals.slice(2).join(' ').trim();
  if (!section || !text) throw new CliError('usage: memory add <file> <section> "<text>"');

  const client = ctx.writeClient();
  try {
    // Fetch the section hash internally: the human never deals with hashes.
    const view = await getCuratedVia(client, ctx, file, section);
    const target = view.sections[0];
    if (!target) throw new CliError(`section '${section}' does not exist in ${view.path_hint}.`);
    // source: 'user' — a human is speaking, so provenance is human_direct.
    // The vault is resolved, never the raw default: a repo marker this process
    // could not honour refuses the write instead of sending it to whichever
    // vault happens to be the default here.
    const res = await client.request('mutate', {
      file, vault: resolveTargetVault(ctx.config),
      expect: { sectionHash: target.section_hash },
      ops: [{ op: 'add', section: target.name, text, source: 'user' }],
      actor: 'user_cli',
    }) as unknown as MutateResult;
    if (values.json) { ctx.io.out(JSON.stringify(res, null, 2)); return; }
    printMutateResult(ctx, 'added', text, res);
  } finally {
    client.close();
  }
}

/** memory edit <file> <section> --match "<old>" --text "<new>" — replace an entry. */
export async function cmdEdit(args: string[], ctx: CliCtx): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { match: { type: 'string' }, text: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
  });
  const file = parseFileArg(positionals[0]);
  const section = positionals[1];
  if (!section || !values.match || !values.text) {
    throw new CliError('usage: memory edit <file> <section> --match "<old text>" --text "<new text>"');
  }

  const client = ctx.writeClient();
  try {
    const view = await getCuratedVia(client, ctx, file, section);
    const target = view.sections[0];
    if (!target) throw new CliError(`section '${section}' does not exist in ${view.path_hint}.`);
    const res = await client.request('mutate', {
      file, vault: resolveTargetVault(ctx.config),
      expect: { sectionHash: target.section_hash },
      ops: [{ op: 'replace', section: target.name, match: values.match, text: values.text, source: 'user' }],
      actor: 'user_cli',
    }) as unknown as MutateResult;
    if (values.json) { ctx.io.out(JSON.stringify(res, null, 2)); return; }
    printMutateResult(ctx, 'replaced', values.text, res);
  } finally {
    client.close();
  }
}

interface ForgetCandidate { file: MemoryFile; path_hint: string; section: string; text: string }

/**
 * The curated files this folder's own vault can hold.
 *
 * ambientReadVault, not the raw default: with a repo marker this process could
 * not honour there is no vault at all, so `show` and `forget` walk nothing
 * instead of reaching another vault's files. Naming a file on purpose
 * (`memory get project`) still gives the explicit VAULT_UNRESOLVED refusal, so
 * the omission is never the only signal. The shared vault has no PROJECT.md by
 * design, which is why it is the one case that drops the project file.
 */
function curatedFiles(ctx: CliCtx): MemoryFile[] {
  const vault = ambientReadVault(ctx.config);
  if (vault === undefined) return [];
  const files: MemoryFile[] = ['user', 'memory'];
  if (vault !== 'global') files.push('project');
  return files;
}

/**
 * Shared confirmation gate for the destructive `forget` actions. Returns true to
 * proceed; returns false only when a human at a real terminal answered no;
 * throws when there is no terminal and no --yes, so a script can never delete
 * or scrub silently.
 */
async function confirmDestructive(ctx: CliCtx, yes: boolean, question: string): Promise<boolean> {
  if (yes) return true;
  if (ctx.io.isTTY && ctx.io.confirm) return ctx.io.confirm(question);
  throw new CliError('Refusing to change files without confirmation. Re-run with --yes to proceed non-interactively.');
}

/** Asks the daemon (the single writer) to scrub the wording from sessions/. */
async function requestSessionsPurge(ctx: CliCtx, query: string): Promise<PurgeSessionsData> {
  const client = ctx.writeClient();
  try {
    return await client.request('sessions.purge', { query }) as PurgeSessionsData;
  } finally {
    client.close();
  }
}

/**
 * memory forget "<text>" — the honest delete. It removes matching curated
 * entries and then states plainly the copies it does NOT reach, so the human is
 * never told the wording is fully gone when it is not.
 */
export async function cmdForget(args: string[], ctx: CliCtx): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      yes: { type: 'boolean' }, 'purge-backups': { type: 'boolean' },
      'purge-sessions': { type: 'boolean' }, json: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const query = positionals.join(' ').trim();
  if (query.length < 3) throw new CliError('usage: memory forget "<text to remove>"  (at least 3 characters)');

  // 1. Find matching curated entries across USER / MEMORY / PROJECT.
  const needle = normalizeForMatch(query);
  const candidates: ForgetCandidate[] = [];
  for (const file of curatedFiles(ctx)) {
    let view: CuratedView;
    try {
      view = await getCurated(ctx, file);
    } catch (e) {
      if (isFileNotFound(e)) continue; // a project vault may have no PROJECT.md
      throw e;
    }
    for (const section of view.sections) {
      for (const entry of section.entries) {
        if (normalizeForMatch(entry.text).includes(needle)) {
          candidates.push({ file, path_hint: view.path_hint, section: section.name, text: entry.text });
        }
      }
    }
  }

  const purgeSessionsRequested = values['purge-sessions'] === true;

  if (candidates.length === 0) {
    ctx.io.out(`No curated memory matched "${query}". Nothing to forget from the curated files.`);
    // If the user explicitly asked to scrub sessions, do it even with no curated
    // hit — that is exactly what --purge-sessions requests. Otherwise stop here.
    if (!purgeSessionsRequested) {
      ctx.io.out('Note: this searched only the curated files (USER/MEMORY/PROJECT). The wording may still live in daily notes, sessions, digests or backups.');
      return;
    }
    if (!(await confirmDestructive(ctx, values.yes === true, 'Scrub matching lines from vault/sessions/ transcripts? [y/N] '))) {
      ctx.io.out('aborted; nothing was changed.');
      return;
    }
    const sp = await requestSessionsPurge(ctx, query);
    if (values.json) {
      ctx.io.out(JSON.stringify(
        { removed: [], ambiguous: [], purged: [], purgeRequested: false, purgeSessionsRequested: true, sessionsPurge: sp },
        null, 2,
      ));
      return;
    }
    printResidueNotice(ctx, { purged: [], purgeRequested: false, sessionsPurge: sp, purgeSessionsRequested: true });
    return;
  }

  // 2. Show exactly what will go.
  ctx.io.out(`Will remove ${candidates.length} curated ${candidates.length === 1 ? 'entry' : 'entries'}:`);
  for (const c of candidates) {
    ctx.io.out(`  ${c.path_hint} / ${c.section}`);
    ctx.io.out(`    - ${c.text}`);
  }

  // 3. Confirm. Without --yes: prompt on a real terminal, refuse otherwise (a
  //    delete must never happen silently in a script without an explicit --yes).
  if (!(await confirmDestructive(ctx, values.yes === true, 'Remove the entries above? [y/N] '))) {
    ctx.io.out('aborted; nothing was removed.');
    return;
  }

  // 4. Remove one at a time, re-reading the section hash before each op so the
  //    pipeline's concurrency guard is satisfied even as the section changes.
  const client = ctx.writeClient();
  const removed: ForgetCandidate[] = [];
  const ambiguous: ForgetCandidate[] = [];
  try {
    for (const c of candidates) {
      const view = await getCuratedVia(client, ctx, c.file, c.section);
      const target = view.sections[0];
      if (!target) continue;
      try {
        await client.request('mutate', {
          file: c.file, vault: resolveTargetVault(ctx.config),
          expect: { sectionHash: target.section_hash },
          ops: [{ op: 'remove', section: target.name, match: c.text }],
          actor: 'user_cli',
        });
        removed.push(c);
      } catch (e) {
        // Two byte-identical bullets: the pipeline refuses to guess which. Skip
        // and tell the human, rather than deleting the wrong one.
        if (e instanceof RpcError && e.code === 'AMBIGUOUS_MATCH') { ambiguous.push(c); continue; }
        throw e;
      }
    }
  } finally {
    client.close();
  }

  ctx.io.out('');
  ctx.io.out(`Removed ${removed.length} of ${candidates.length} curated ${candidates.length === 1 ? 'entry' : 'entries'}.`);
  if (ambiguous.length > 0) {
    // The pipeline refuses when the text also appears inside another bullet in
    // the same section (identical or as a substring); deleting the wrong one is
    // worse than skipping.
    ctx.io.out(`Skipped ${ambiguous.length}: the text also matches another bullet in the same section. Use "memory edit" or Obsidian to remove those by hand.`);
  }

  // 5. Optional: delete the backups that actually contain the text.
  let purged: string[] = [];
  const purgeRequested = values['purge-backups'] === true;
  if (purgeRequested) {
    const files = [...new Set(removed.map((c) => c.file))];
    purged = purgeBackups(ctx.config, files, query);
  }

  // 6. Optional and explicit: scrub the same wording from the redacted session
  //    transcripts. Off by default — a purge must never happen without the flag.
  //    Goes through the daemon (the single writer): the CLI never rewrites vault
  //    files itself. Confirmation already happened in step 3 (it covers this).
  let sessionsPurge: PurgeSessionsData | undefined;
  if (purgeSessionsRequested) {
    sessionsPurge = await requestSessionsPurge(ctx, query);
  }

  if (values.json) {
    ctx.io.out(JSON.stringify(
      { removed, ambiguous, purged, purgeRequested, purgeSessionsRequested, sessionsPurge: sessionsPurge ?? null },
      null, 2,
    ));
    return;
  }
  printResidueNotice(ctx, { purged, purgeRequested, sessionsPurge, purgeSessionsRequested });
}

/** Deletes .bak files (of the given curated files) whose content holds the text. */
function purgeBackups(config: MemoryConfig, files: MemoryFile[], query: string): string[] {
  const q = query.toLowerCase();
  const deleted: string[] = [];
  for (const file of files) {
    let resolved: ReturnType<typeof resolveMemoryFile>;
    try {
      // Same fail-closed vault as every other curated path: a broken marker
      // must not point this delete at another vault's backup folder. An absent
      // vault makes resolveMemoryFile throw, and the catch below skips the file.
      resolved = resolveMemoryFile(config, file, ambientReadVault(config));
    } catch {
      continue;
    }
    const backupDir = path.join(resolved.vaultRoot, '.memory', 'backups', path.dirname(resolved.relPath));
    if (!fs.existsSync(backupDir)) continue;
    const prefix = `${path.basename(resolved.relPath)}.`;
    for (const name of fs.readdirSync(backupDir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.bak')) continue;
      const abs = path.join(backupDir, name);
      let content = '';
      try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      if (content.toLowerCase().includes(q)) {
        fs.rmSync(abs, { force: true });
        deleted.push(abs);
      }
    }
  }
  return deleted;
}

interface ResidueInfo {
  purged: string[];
  purgeRequested: boolean;
  sessionsPurge?: PurgeSessionsData | undefined;
  purgeSessionsRequested: boolean;
}

/** The load-bearing honesty of `forget`: name every place the text may survive. */
function printResidueNotice(ctx: CliCtx, info: ResidueInfo): void {
  ctx.io.out('');
  ctx.io.out('Residue notice — "forget" removed the entries above from the curated files only.');
  ctx.io.out('The same wording may still exist in these places, which this command does NOT erase:');
  if (info.purgeRequested) {
    ctx.io.out(`  a) backups: purged ${info.purged.length} .bak file(s) that contained the text.`);
  } else {
    ctx.io.out('  a) backups: .memory/backups/ keeps the last ~20 versions of each file. Re-run with --purge-backups to delete the ones that contain this text.');
  }
  ctx.io.out('  b) archive: a *-archive.md file, if an entry was ever demoted instead of deleted.');
  if (info.purgeSessionsRequested) {
    // Report what the scrub reached (line-level, across sessions/*.md).
    const s = info.sessionsPurge;
    const files = s?.changedFiles.length ?? 0;
    const lines = s?.totalPurgedLines ?? 0;
    ctx.io.out(`  c) sessions: scrubbed ${lines} line(s) in ${files} transcript file(s) (replaced with [PURGED]).`);
  } else {
    ctx.io.out('  c) sessions: sessions/ holds verbatim (redacted) transcripts. Re-run with --purge-sessions to scrub matching lines.');
  }
  // Git history is a separate concern: this command never rewrites it.
  ctx.io.out('  d) git history: older commits may still contain this text. Rewriting git history is out of scope here; remove it from past commits yourself with git if you need that.');
}

// ---------------------------------------------------------------------------
// show / log — the read-back of everything.
// ---------------------------------------------------------------------------

function listMd(dir: string | undefined): string[] {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort();
}

/** Counts '- ' bullet lines across a set of markdown files (daily/archive). */
function countBullets(absFiles: string[]): number {
  let n = 0;
  for (const abs of absFiles) {
    if (!fs.existsSync(abs)) continue;
    for (const line of fs.readFileSync(abs, 'utf8').split('\n')) {
      if (/^\s*[-*+]\s+/.test(line)) n++;
    }
  }
  return n;
}

/** Recursively counts .bak files under a vault's backup directory. */
function countBackups(vaultRoot: string | undefined): number {
  if (!vaultRoot) return 0;
  const root = path.join(vaultRoot, '.memory', 'backups');
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.bak')) n++;
    }
  };
  walk(root);
  return n;
}

interface LayerSummary { lines: string[]; data: Record<string, unknown> }

/**
 * Counts and locations for every non-curated layer of the memory system.
 *
 * Every layer lives in the vault of the repo it came from, so this walks exactly
 * the caller's readable set: this folder's own vault, plus the shared vault only
 * when this folder's `.memory.yml` says `share_global: true`. It is the same set
 * an agent here would read, so `show` never reveals a vault a search here cannot
 * reach, and never reports "0 files" while the files sit on disk in the vault it
 * forgot to look at. Every line names its vault, so no count can be read against
 * the wrong one.
 */
function summarizeLayers(config: MemoryConfig, all: boolean): LayerSummary {
  const lines: string[] = [];
  const data: Record<string, unknown> = {};

  // readableVaults with no explicit vault: this process's own ambient scope. A
  // marker it could not honour gives an empty list, and every layer then reports
  // its zero rather than describing another vault's files.
  const scoped: Array<{ name: string; root: string }> = [];
  for (const name of readableVaults(config) ?? []) {
    const root = config.vaults[name];
    if (root) scoped.push({ name, root });
  }

  const digestFiles: Array<{ vault: string; name: string }> = [];
  const archiveFiles: Array<{ vault: string; abs: string }> = [];
  for (const { name: vault, root } of scoped) {
    for (const file of listMd(path.join(root, 'digests'))) digestFiles.push({ vault, name: file });
    // All three curated files live in every vault now, so all three archives do.
    for (const file of ['USER-archive.md', 'MEMORY-archive.md', 'PROJECT-archive.md']) {
      const abs = path.join(root, file);
      if (fs.existsSync(abs)) archiveFiles.push({ vault, abs });
    }
  }
  const archiveEntries = countBullets(archiveFiles.map((f) => f.abs));
  const backups = scoped.reduce((n, v) => n + countBackups(v.root), 0);

  // The vault column is what makes a count unambiguous once a layer can live in
  // more than one vault. '-' marks a row that is not about one single vault.
  const push = (label: string, vault: string, count: string, where: string, names?: string[]): void => {
    lines.push(`  ${label.padEnd(9)} ${vault.padEnd(10)} ${count.padEnd(24)} ${where}`);
    if (all && names && names.length > 0) for (const n of names) lines.push(`                 - ${n}`);
  };
  // Paths are shown with the platform separator (path.sep + a trailing one), so
  // the output is right on macOS/Linux too, not only on Windows.
  const dirHint = (root: string, sub: string): string => `${path.join(root, sub)}${path.sep}`;
  // The "no readable vault" location: this folder's marker could not be used, so
  // there is no folder to point at.
  const noVault = '(no vault readable here)';

  // One line per vault for the two per-vault layers. A vault with nothing in it
  // still prints its zero: an empty line is an answer, a missing line is not.
  const sessionsData: Record<string, unknown> = {};
  let sessionFiles = 0;
  for (const { name, root } of scoped) {
    const files = listMd(path.join(root, 'sessions'));
    push('sessions', name, `${files.length} transcript file(s)`, dirHint(root, 'sessions'), files);
    sessionsData[name] = { count: files.length, files };
    sessionFiles += files.length;
  }
  if (scoped.length === 0) push('sessions', '-', '0 transcript file(s)', noVault);

  const dailyData: Record<string, unknown> = {};
  let dailyFiles = 0;
  let dailyEntries = 0;
  for (const { name, root } of scoped) {
    const files = listMd(path.join(root, 'daily'));
    const entries = countBullets(files.map((f) => path.join(root, 'daily', f)));
    push('daily', name, `${files.length} day file(s), ${entries} entries`, dirHint(root, 'daily'), files);
    dailyData[name] = { files: files.length, entries };
    dailyFiles += files.length;
    dailyEntries += entries;
  }
  if (scoped.length === 0) push('daily', '-', '0 day file(s), 0 entries', noVault);

  // digests/ is no longer written (the weekly digest was built from the review
  // queue, which is gone), but a vault set up before that still holds the files
  // and the indexer still reads them. Keep counting them so nothing the system
  // can still search is invisible here.
  push('digests', '-', `${digestFiles.length} file(s)`,
    digestFiles.length > 0
      ? [...new Set(digestFiles.map((f) => `${f.vault}:digests`))].join(', ')
      : `${path.join('digests')}${path.sep} under each vault`,
    digestFiles.map((f) => `${f.vault}:${f.name}`));
  // Archive files are named per vault in the location column, so one aggregate
  // line stays unambiguous without a second row.
  push('archive', '-', `${archiveEntries} demoted entry(ies)`,
    archiveFiles.length > 0 ? archiveFiles.map((f) => `${f.vault}:${path.basename(f.abs)}`).join(', ') : '(none)');
  push('backups', '-', `${backups} .bak file(s)`, `${path.join('.memory', 'backups')}${path.sep} under each vault  (memory forget --purge-backups)`);

  data['sessions'] = { count: sessionFiles, byVault: sessionsData };
  data['daily'] = { files: dailyFiles, entries: dailyEntries, byVault: dailyData };
  data['digests'] = { count: digestFiles.length, files: digestFiles.map((f) => `${f.vault}:${f.name}`) };
  data['archive'] = { entries: archiveEntries, files: archiveFiles.map((f) => `${f.vault}:${path.basename(f.abs)}`) };
  data['backups'] = { count: backups };
  return { lines, data };
}

/** memory show [--all] — curated content plus a count of every other layer. */
export async function cmdShow(args: string[], ctx: CliCtx): Promise<void> {
  const { values } = parseArgs({ args, options: { all: { type: 'boolean' }, json: { type: 'boolean' } }, allowPositionals: false });
  const all = values.all === true;

  const curated: CuratedView[] = [];
  for (const file of curatedFiles(ctx)) {
    try {
      curated.push(await getCurated(ctx, file));
    } catch (e) {
      if (isFileNotFound(e)) continue;
      throw e;
    }
  }
  const layers = summarizeLayers(ctx.config, all);

  if (values.json) {
    ctx.io.out(JSON.stringify({ curated, layers: layers.data }, null, 2));
    return;
  }

  ctx.io.out('=== Curated memory (the source of truth) ===');
  for (const view of curated) {
    ctx.io.out('');
    renderCuratedView(ctx, view, { hashes: false });
  }
  ctx.io.out('');
  // The vault column arrived with the per-vault layers, so name the columns:
  // a bare count next to a folder path no longer says which vault it belongs to.
  ctx.io.out('=== Other memory layers (not curated). Columns: layer, vault, count, where ===');
  for (const line of layers.lines) ctx.io.out(line);
}

/**
 * memory log [--limit n] — the write audit trail (who/what wrote, when).
 *
 * Reads the DURABLE store (one JSONL under each vault's .memory/), NOT the
 * SQLite index. The index is rebuildable and `memory reset`/`uninstall` wipe it,
 * so the audit trail has to live outside it; the durable file is the truth.
 * The app that wrote each entry is shown when known (from the MCP handshake),
 * falling back to the actor otherwise.
 */
export async function cmdLog(args: string[], ctx: CliCtx): Promise<void> {
  const { values } = parseArgs({ args, options: { limit: { type: 'string' }, json: { type: 'boolean' } }, allowPositionals: false });
  const limit = values.limit ? Math.max(1, Math.min(1000, Number(values.limit) || 20)) : 20;

  // One durable file per configured vault; readWriteLog merges and sorts them.
  const roots = Object.values(ctx.config.vaults);
  const rows = readWriteLog(roots, limit);
  if (values.json) { ctx.io.out(JSON.stringify(rows, null, 2)); return; }
  if (rows.length === 0) { ctx.io.out('write log is empty.'); return; }
  for (const r of rows) {
    // Name the app when the handshake gave one; else the label is just the actor.
    const app = r.client ? `  (app: ${r.client})` : '';
    // The claimed provenance, so a smuggled source:'user' is visible in the
    // trail next to the server-set actor. Old log lines have no source (the
    // field is skipped then), which is fine — this is display only.
    const src = r.source ? `  src:${r.source}` : '';
    ctx.io.out(
      `${new Date(r.ts).toISOString()}  ${r.actor.padEnd(14)} ${r.op.padEnd(14)} ` +
      `${r.vault}:${r.path}${r.section ? ' / ' + r.section : ''}${src}${app}`,
    );
  }
}

/**
 * Runs a new command and maps its outcome to a process exit code, turning the
 * daemon's typed errors into a clean one-line message (never a stack trace).
 */
async function runNew(fn: () => Promise<void>): Promise<number> {
  try {
    await fn();
    return 0;
  } catch (e) {
    const err = (s: string): boolean => process.stderr.write(s + '\n');
    // Both are the same kind of thing: a human-fixable mistake, one clean line.
    if (e instanceof CliError || e instanceof VaultCommandError) { err(e.message); return 1; }
    if (e instanceof RpcError || e instanceof ToolError) { err(`error ${e.code}: ${e.message}`); err(`  ${e.hint}`); return 1; }
    if (e instanceof DaemonUnavailableError) {
      err(`error: ${e.message}`);
      err('  The daemon should start on its own; retry, or run: memory daemon start.');
      return 1;
    }
    throw e;
  }
}

/**
 * Dispatch. Returns a process exit code so an unknown command can fail loudly
 * without process.exit deep in the tree (which also keeps it unit-testable). An
 * unknown/misspelled command prints usage to STDERR and returns 1: a silent
 * exit-0 would hide typos.
 */
export async function dispatch(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    // Print the version cleanly and exit 0 (it is not an unknown command).
    case '--version':
    case '-v':
      process.stdout.write(`${readVersion()}\n`);
      return 0;
    // Asking for help is not an error. It goes to STDOUT with exit 0, so `memory
    // --help | less` works and a script does not read it as a failure. `undefined`
    // is a bare `memory` with no arguments: the person wants to know what this
    // command does, which is the same request. Only a command we do not know
    // still goes to STDERR with exit 1.
    case '--help':
    case '-h':
    case 'help':
    case undefined:
      process.stdout.write(USAGE);
      return 0;
    case 'init': await cmdInit(rest); return 0;
    case 'index': await cmdIndex(rest); return 0;
    case 'vault': return runNew(() => cmdVault(rest, { out: (line) => process.stdout.write(line + '\n') }));
    case 'search': await cmdSearch(rest); return 0;
    case 'status': await cmdStatus(); return 0;
    case 'show': return runNew(() => cmdShow(rest, defaultCtx()));
    case 'get': return runNew(() => cmdGet(rest, defaultCtx()));
    case 'add': return runNew(() => cmdAdd(rest, defaultCtx()));
    case 'edit': return runNew(() => cmdEdit(rest, defaultCtx()));
    case 'forget': return runNew(() => cmdForget(rest, defaultCtx()));
    case 'log': return runNew(() => cmdLog(rest, defaultCtx()));
    case 'snapshot': await cmdSnapshot(rest); return 0;
    case 'backup': {
      const c = new DaemonClient();
      try { console.log(JSON.stringify(await c.request('backup'), null, 2)); } finally { c.close(); }
      return 0;
    }
    case 'daemon': await cmdDaemon(rest); return 0;
    case 'doctor': await cmdDoctor(); return 0;
    case 'uninstall': await cmdUninstall(rest); return 0;
    case 'reset': await cmdReset(rest); return 0;
    default:
      process.stderr.write(`unknown command${command ? ` '${command}'` : ''}\n\n${USAGE}`);
      return 1;
  }
}

/**
 * True only when this file is the process entry point (a real CLI run), false
 * when a test imports dispatch/cmd*. Both sides are compared by their REAL path
 * (symlinks resolved): `npm link` and `npm install -g` expose the bin through a
 * symlink, so process.argv[1] is the link while import.meta.url is already the
 * resolved target. Without realpath the two never match, and the linked `memory`
 * command would parse no command and silently exit 0.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fs.realpathSync(path.resolve(entry)) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that cannot be resolved (removed, permission denied) is not our entry.
    return false;
  }
}

const isMain = isMainModule();

if (isMain) {
  dispatch(process.argv.slice(2))
    .then((code) => { if (code !== 0) process.exit(code); })
    .catch((e) => {
      // When the daemon could not be reached, the bare message is a dead end.
      // Point at its log (a failed bind is recorded there) and at diagnostics.
      if (e instanceof DaemonUnavailableError) {
        const logPath = path.join(dataDir(), 'logs', 'memoryd.log');
        fail(`${e.message}\n  The daemon may have failed to start. Check its log:\n    ${logPath}\n  Then run: memory doctor`);
      }
      fail(e instanceof Error ? e.message : String(e));
    });
}
