import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import yaml from 'js-yaml';
import { configDir, indexRootDir, runtimeDir } from '../core/paths.js';
import { resolveConfigSource, describeConfigOrigin } from '../core/config.js';
import { canonicalize } from '../core/text/canonicalize.js';
import { detectEol, applyEol } from '../core/text/eol.js';
import { normalizeForMatch } from '../core/text/normalize.js';
import { parseSections } from '../core/markdown/sections.js';
import { atomicWriteMarkdown } from '../core/atomic-write.js';
import { ulid, memComment } from '../core/provenance.js';
import {
  buildHooksBlock, detectClaudeCode, registerClaudeHooks, resolveHookScripts,
  type HookScripts,
} from './hooks-register.js';

/**
 * `memory init`: zero-to-working in one command. Picks a vault, seeds it with
 * curated files an agent can write to, writes the OS-config-dir config.yml,
 * makes sure the index dir exists, and prints the exact MCP registration line.
 *
 * It never writes or asks for a secret: capture (the only feature that sends
 * data off the machine) stays OFF until the user adds an OpenRouter key by
 * hand. The function that does the work returns a structured result and touches
 * only paths derived from configDir()/indexRootDir()/runtimeDir()/the chosen
 * vault, so tests redirect them to temp dirs and nothing touches a real setup.
 */

/** The config file already exists and --force was not given: refuse to clobber it. */
export class ConfigExistsError extends Error {
  constructor(public readonly configPath: string) {
    super(
      `A config file already exists at ${configPath}. `
      + 'Refusing to overwrite it. Re-run with --force to replace it '
      + '(the vaults already listed in it are kept), or edit that file by hand.',
    );
    this.name = 'ConfigExistsError';
  }
}

export interface InitOptions {
  /** Absolute (or resolvable) vault path. Required by initMemory (cmdInit resolves it first). */
  vault: string;
  /** Config vault name; defaults to 'global'. */
  name?: string | undefined;
  /** Overwrite an existing config file. */
  force?: boolean | undefined;
}

export interface InitResult {
  vaultPath: string;
  vaultName: string;
  configPath: string;
  indexDir: string;
  /** Runtime dir for the Unix socket; created so the first daemon bind never
   * fails on a missing parent (no-op identity of the data dir on Windows). */
  runtimeDir: string;
  /** Absolute path to this install's dist/mcp/index.js — the MCP server entry. */
  mcpServerJs: string;
  /** Seed files newly created in the vault (basename). */
  seeded: string[];
  /** Seed files left untouched because the vault already had them (basename). */
  keptExisting: string[];
  /** true when a pre-existing config.yml was replaced because --force was set. */
  overwroteConfig: boolean;
  /**
   * Vault names carried over from the config file --force replaced, excluding
   * the one this run named. Printed, so keeping them is visible and not a
   * silent side effect.
   */
  keptVaults: string[];
  /**
   * true when the replaced config file existed but could not be read as a YAML
   * mapping, so no vault could be carried over. The caller SAYS this instead of
   * quietly keeping nothing.
   */
  oldConfigUnreadable: boolean;
}

/**
 * The vaults listed in a config file that is about to be overwritten.
 *
 * Only plain `name: path` string pairs are carried over: this feeds a file we
 * then write, so a malformed entry must not travel into it. An empty file is a
 * normal case, not a failure; a file that does not parse, or that is not a YAML
 * mapping, sets `unreadable` so the caller can report it.
 */
function readConfiguredVaults(configPath: string): { vaults: Record<string, string>; unreadable: boolean } {
  let parsed: unknown;
  try {
    parsed = yaml.load(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { vaults: {}, unreadable: true };
  }
  if (parsed === null || parsed === undefined) return { vaults: {}, unreadable: false };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return { vaults: {}, unreadable: true };
  const raw = (parsed as Record<string, unknown>)['vaults'];
  if (raw === null || raw === undefined) return { vaults: {}, unreadable: false };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { vaults: {}, unreadable: true };
  const vaults: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim() !== '') vaults[name] = value;
  }
  return { vaults, unreadable: false };
}

/**
 * Curated seed files: heading + at least one <!-- auto --> section so agent
 * writes have a target. The guidance lines are HTML comments, not bullets, on
 * purpose: a comment is stripped from the budget and from the frozen snapshot,
 * so an empty vault never injects fake "memory" into a session. Real content
 * arrives from the init questions (see seedFacts) or from `memory add`.
 */
export const SEED_FILES: Record<string, string> = {
  'USER.md': `# USER

Who you are. Curated file, edited by hand. The daemon never rewrites this file
on its own. Sections marked <!-- auto --> accept agent writes (through the
daemon); the other sections change only by hand.

## Profile

<!-- One or two lines about you: your name, your role, what you work on.
     Add one with: memory add user Profile "Alice, backend engineer at Acme; works on payments." -->

## Preferences <!-- auto -->

<!-- How you like answers written.
     Add one with: memory add user Preferences "Keep answers short: one idea at a time." -->
`,
  'MEMORY.md': `# MEMORY

Durable facts and conventions that cross projects. Sections marked <!-- auto -->
accept agent writes (through the daemon); the other sections change only by hand.

## Decisions <!-- auto -->

<!-- Cross-project decisions worth remembering.
     Add one with: memory add memory Decisions "..." -->

## Conventions <!-- auto -->

<!-- Rules you always want followed.
     Add one with: memory add memory Conventions "Commit messages in English, no AI attribution lines." -->

## Environment gotchas <!-- auto -->

<!-- Setup steps that are easy to get wrong on this machine.
     Add one with: memory add memory "Environment gotchas" "..." -->
`,
};

/**
 * The curated seed for a project vault, in the same shape as SEED_FILES above:
 * a heading, sections marked <!-- auto --> so agent writes have a target, and
 * guidance kept in HTML comments so it costs no budget and never reaches a
 * session as fake memory.
 *
 * `memory init` does not write it: the vault init creates is the shared personal
 * one, and PROJECT.md belongs to a project vault. `memory vault add` writes it
 * alongside USER.md and MEMORY.md, because every vault is self-contained now and
 * a vault without these files answers FILE_NOT_FOUND on the first write.
 */
export const PROJECT_SEED = `# PROJECT

Notes about this project. Sections marked <!-- auto --> accept agent writes
(through the daemon); the other sections change only by hand.

## Decisions <!-- auto -->

<!-- Decisions taken in this project.
     Add one with: memory add project Decisions "..." -->

## Conventions <!-- auto -->

<!-- Rules this project always follows.
     Add one with: memory add project Conventions "..." -->
`;

/**
 * Absolute path to this install's dist/mcp/index.js, resolved relative to THIS
 * module so it is correct wherever the repo was cloned. When the CLI runs from
 * the src layout (dev, tests), the resolved path points at src/mcp; the printed
 * line must always name the built entry, so the build-layout segment ('src') is
 * normalized to 'dist'. Only that one segment is touched, never an accidental
 * 'src' elsewhere in the path.
 */
export function resolveMcpServerJs(): string {
  const p = fileURLToPath(new URL('../mcp/index.js', import.meta.url));
  const layoutDir = path.dirname(path.dirname(p)); // .../<layout>
  if (path.basename(layoutDir) === 'src') {
    return path.join(path.dirname(layoutDir), 'dist', 'mcp', 'index.js');
  }
  return p;
}

/** The MCP registration JSON the user pastes into their agent's config. */
export function buildMcpConfig(serverJs: string): string {
  return JSON.stringify(
    { mcpServers: { memory: { command: 'node', args: [serverJs] } } },
    null,
    2,
  );
}

/** One first fact the user gives during init: which curated file/section, and the text. */
export interface SeedFact {
  file: 'user' | 'memory';
  section: string;
  text: string;
}

export interface SeedResult {
  file: 'user' | 'memory';
  section: string;
  text: string;
  path_hint: string;
}

/**
 * Seeds the user's first real facts into USER.md / MEMORY.md so the very first
 * session is not empty placeholder text. Each fact becomes a bullet with the
 * SAME shape and provenance `memory add` produces for a human-stated fact
 * (`- <text> <!-- mem id=<ULID> src:human -->`), so search, `memory get`, and
 * the frozen snapshot all treat it as trusted, human-direct memory.
 *
 * This runs at setup time, before any daemon or index exists, so it writes the
 * files directly with the same low-level primitives the write pipeline uses (no
 * daemon round-trip). The daemon indexes them on its first start. Because the
 * person is populating their OWN vault by hand here, the `<!-- auto -->` gate
 * (which only exists to fence AGENT writes) does not apply; a named section that
 * exists is written to, human-only or not.
 */
export async function seedFacts(vaultRoot: string, facts: SeedFact[]): Promise<SeedResult[]> {
  const written: SeedResult[] = [];
  for (const fact of facts) {
    if (!fact.text.trim()) continue; // an empty answer seeds nothing
    const rel = fact.file === 'user' ? 'USER.md' : 'MEMORY.md';
    const abs = path.join(vaultRoot, rel);
    const raw = fs.readFileSync(abs, 'utf8');
    const eol = detectEol(raw);
    const canonical = canonicalize(raw);
    const sections = parseSections(canonical);
    const target = sections.find((s) => normalizeForMatch(s.name) === normalizeForMatch(fact.section));
    if (!target) {
      throw new Error(`Cannot seed: section '${fact.section}' does not exist in ${rel}.`);
    }
    // Mirror the pipeline's add: insert after the last bullet, else at section end.
    const line = `- ${fact.text.trim()} ${memComment(ulid(), 'human_direct')}`;
    const lastEntry = target.entries[target.entries.length - 1];
    const insertAt = lastEntry ? lastEntry.charEnd + 1 : target.charEnd;
    const next = canonicalize(canonical.slice(0, insertAt) + line + '\n' + canonical.slice(insertAt));
    await atomicWriteMarkdown(abs, applyEol(next, eol));
    written.push({ file: fact.file, section: fact.section, text: fact.text.trim(), path_hint: `global:${rel}` });
  }
  return written;
}

/**
 * Does the filesystem work and returns a structured result. No prompting, no
 * printing: cmdInit resolves the vault and prints; this stays pure so tests can
 * assert on the outcome. Order: vault dir + seeds (missing only), config
 * (refuse-or-force), index dir.
 */
export function initMemory(opts: InitOptions): InitResult {
  const vaultName = opts.name ?? 'global';
  const vaultPath = path.resolve(opts.vault);

  // Vault + seeds. Never overwrite an existing seed file: a vault that already
  // has USER.md/MEMORY.md keeps the user's content untouched.
  fs.mkdirSync(vaultPath, { recursive: true });
  const seeded: string[] = [];
  const keptExisting: string[] = [];
  for (const [name, body] of Object.entries(SEED_FILES)) {
    const file = path.join(vaultPath, name);
    if (fs.existsSync(file)) {
      keptExisting.push(name);
      continue;
    }
    fs.writeFileSync(file, body, 'utf8');
    seeded.push(name);
  }

  // Config: OS config dir (MEMORY_CONFIG_DIR redirects it for tests/CI). Refuse
  // to clobber an existing config unless --force. Capture stays OFF: no
  // openrouter block is written.
  const dir = configDir();
  const configPath = path.join(dir, 'config.yml');
  const existed = fs.existsSync(configPath);
  if (existed && !opts.force) throw new ConfigExistsError(configPath);
  fs.mkdirSync(dir, { recursive: true });

  // --force replaces this file. It used to write a vaults map with ONE entry, so
  // every vault registered later with `memory vault add` was dropped, and the
  // person only found out when searches came back empty months later. Carry the
  // old entries over instead. Merging rather than refusing keeps the command
  // usable, and it cannot lose data; the vault named on THIS run wins, because
  // asking for it is the whole point of the command.
  const previous = existed && opts.force
    ? readConfiguredVaults(configPath)
    : { vaults: {}, unreadable: false };
  const vaults: Record<string, string> = { ...previous.vaults, [vaultName]: vaultPath };

  const configBody = yaml.dump({
    vaults,
    default_vault: vaultName,
    embeddings: { enabled: true, model: 'multilingual-e5-small' },
  });
  fs.writeFileSync(configPath, configBody, 'utf8');

  // Index dir: just make sure it exists so the first daemon reconcile is not
  // blocked. The real indexing happens when the daemon starts.
  const indexDir = indexRootDir();
  fs.mkdirSync(indexDir, { recursive: true });

  // Runtime dir: on macOS/Linux the daemon binds a Unix socket here; if the dir
  // is missing the first bind fails with ENOENT. Create it now (belt and
  // suspenders with the daemon's own mkdir). On Windows this is the data dir,
  // which already exists — a harmless no-op.
  const runtime = runtimeDir();
  fs.mkdirSync(runtime, { recursive: true });

  return {
    vaultPath,
    vaultName,
    configPath,
    indexDir,
    runtimeDir: runtime,
    mcpServerJs: resolveMcpServerJs(),
    seeded,
    keptExisting,
    overwroteConfig: existed && !!opts.force,
    keptVaults: Object.keys(previous.vaults).filter((n) => n !== vaultName),
    oldConfigUnreadable: previous.unreadable,
  };
}

/** Default vault when the user gives no --vault and is not prompted. */
function defaultVaultPath(): string {
  return path.join(os.homedir(), 'memory-vault');
}

export interface CmdInitDeps {
  /** Output sink; defaults to console.log. Tests inject a capturing sink. */
  log?: (line: string) => void;
  /** Free-text prompt; defaults to a readline question. Tests inject answers. */
  ask?: (question: string) => Promise<string>;
  /** Yes/no prompt; defaults to a readline question. Tests inject answers. */
  confirm?: (question: string) => Promise<boolean>;
  /** Force interactive mode regardless of the real TTY (tests). */
  interactive?: boolean;
}

/** Usage for `memory init`, shown on --help so the flag list is discoverable. */
const INIT_USAGE = `usage: memory init [options]
  set up the system in one command
      --vault <path>   vault folder (else prompt on a TTY, else <home>/memory-vault)
      --name <name>    config vault name (default global)
      --force          replace an existing config file (vaults already in it are kept)
      --hooks          register the Claude Code hooks (memory turns on automatically)
      --no-hooks       do not touch settings; just print the hooks block to paste
      --settings <path>  settings.json to register hooks in (default: <home>/.claude/settings.json)
      --non-interactive  never prompt; use the default vault when --vault is absent
      --help           show this help`;

/** Reads one free-text answer from a real terminal (default ask). */
async function readlineAsk(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Reads one y/N answer from a real terminal (default confirm); default yes on empty. */
async function readlineConfirm(question: string): Promise<boolean> {
  const answer = (await readlineAsk(question)).toLowerCase();
  return answer === '' || answer === 'y' || answer === 'yes';
}

/**
 * The three interactive setup questions. Each answer becomes a first real fact
 * (empty answers are skipped by seedFacts). Order: identity, then a convention,
 * then an answer-style preference.
 */
const SEED_QUESTIONS: ReadonlyArray<{ question: string; file: 'user' | 'memory'; section: string }> = [
  { question: 'One line about who you are (name, role, what you work on): ', file: 'user', section: 'Profile' },
  { question: 'A work convention you always want followed (Enter to skip): ', file: 'memory', section: 'Conventions' },
  { question: 'How should answers be written? (Enter to skip): ', file: 'user', section: 'Preferences' },
];

/**
 * Prints the paste-by-hand hooks block plus a short explanation. Used when the
 * user declined (--no-hooks), when no settings file could be created, or when
 * Claude Code was not detected.
 */
function printManualHooks(log: (line: string) => void, scripts: HookScripts): void {
  log('Claude Code hooks (make memory automatic) -- paste this into your');
  log('settings.json (usually ~/.claude/settings.json), merging into any "hooks" you have:');
  log('');
  log(JSON.stringify(buildHooksBlock(scripts), null, 2));
  log('');
  log('  Or re-run with --hooks to let init merge them in for you.');
  log('  Restart Claude Code afterwards so the hooks load.');
}

/**
 * Prints the config file that loadConfig will actually READ. When that file is
 * not the one init just wrote (a repo-root config.local.yml, or MEMORY_CONFIG,
 * shadows the OS-dir config), it prints a loud WARNING instead: this is the
 * exact footgun a user hit — re-scoping the vault in a file that is then
 * silently ignored (finding 5).
 */
function reportActiveConfig(log: (line: string) => void, writtenConfigPath: string): void {
  const active = resolveConfigSource();
  const sameFile = path.resolve(active.path) === path.resolve(writtenConfigPath);
  if (active.exists && !sameFile) {
    log('WARNING: the config just written is NOT the file that will be read.');
    log(`  active config (wins): ${active.path}  (${describeConfigOrigin(active.origin)})`);
    log(`  init wrote:           ${writtenConfigPath}  (shadowed; it will be ignored)`);
    log('  Fix one: edit the active file instead, or delete it, or point MEMORY_CONFIG at the file you want.');
    log('');
    return;
  }
  log(`config in use: ${active.path}  (${describeConfigOrigin(active.origin)})`);
  log('');
}

/**
 * CLI entry: parse flags, resolve the vault (flag > interactive prompt on a TTY
 * > default), run initMemory, seed the first facts, register the Claude Code
 * hooks (opt-in), and print a clean, skimmable report with the MCP snippet and
 * next steps.
 */
export async function cmdInit(args: string[], deps: CmdInitDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string): void => console.log(line));
  const ask = deps.ask ?? readlineAsk;
  const confirm = deps.confirm ?? readlineConfirm;

  // --help / -h is handled before parseArgs: parseArgs would reject an unknown
  // option with "Unknown option '--help'", which is the opposite of helpful.
  if (args.includes('--help') || args.includes('-h')) {
    log(INIT_USAGE);
    return;
  }

  const { values } = parseArgs({
    args,
    options: {
      vault: { type: 'string' },
      name: { type: 'string' },
      force: { type: 'boolean' },
      hooks: { type: 'boolean' },
      'no-hooks': { type: 'boolean' },
      settings: { type: 'string' },
      'non-interactive': { type: 'boolean' },
    },
    allowPositionals: false,
  });

  // Interactive = a real TTY not told to stay quiet, or forced by a test. When
  // forced, the injected ask/confirm drive it without touching real stdin.
  const interactive = deps.interactive ?? (process.stdin.isTTY === true && !values['non-interactive']);

  // Vault resolution: an explicit flag wins; otherwise prompt when interactive;
  // otherwise the safe default.
  const fallback = defaultVaultPath();
  let vault = values.vault;
  if (!vault) {
    vault = interactive ? ((await ask(`Vault folder [${fallback}]: `)) || fallback) : fallback;
  }

  const result = initMemory({ vault, name: values.name, force: values.force });

  log('memory init: done.');
  log('');
  log(`vault:  ${result.vaultPath}  (name: ${result.vaultName})`);
  if (result.seeded.length > 0) log(`  seeded: ${result.seeded.join(', ')}`);
  if (result.keptExisting.length > 0) log(`  kept existing (not overwritten): ${result.keptExisting.join(', ')}`);
  log(`config: ${result.configPath}${result.overwroteConfig ? '  (replaced with --force)' : ''}`);
  // --force rewrites the file. Say out loud what survived, so the person does
  // not have to open the file to find out whether their other vaults are gone.
  if (result.keptVaults.length > 0) {
    log(`  kept the vaults already in that file: ${result.keptVaults.join(', ')}`);
  }
  if (result.oldConfigUnreadable) {
    log('  WARNING: the old config file could not be read as YAML, so no vault could be kept');
    log('  from it. If you had other vaults there, add them again with: memory vault add <name> <path>');
  }
  log(`index:  ${result.indexDir}`);
  log('');

  // Name the config file that will actually be READ, and warn loudly if it is
  // not the one just written (finding 5: a repo-root config.local.yml, or
  // MEMORY_CONFIG, shadows the OS-dir config init writes).
  reportActiveConfig(log, result.configPath);

  // Seed the first real facts so the first session is not empty placeholder text.
  await seedStep(log, ask, interactive, result.vaultPath);

  log('Capture is OFF (nothing leaves your machine). Two ways to turn it on later,');
  log(`both in ${result.configPath}:`);
  log('  1. Claude Code users, no extra key: add these two lines');
  log('       triage:');
  log('         backend: claude-cli');
  log('     Session snippets then go to Anthropic on your own Claude account.');
  log('  2. Any other setup: an "openrouter" block with "api_key".');
  // The active-config warning above can say this file is shadowed and ignored;
  // the key is the exception, so state plainly it is still read from here.
  log('  The OpenRouter key is read from this file even if the config above is shadowed.');
  log('');
  log('MCP server registration -- paste this into your agent\'s MCP config:');
  log('');
  log(buildMcpConfig(result.mcpServerJs));
  log('');
  log('  Works for Claude Code, Claude Desktop, Cursor, and any MCP client. See');
  log('  docs/agent-guide.md for how an agent should use it.');
  log('');

  // Register the Claude Code hooks (this is what makes memory automatic there).
  await hooksStep(log, confirm, interactive, values);

  log('Non-Claude agents (Cursor, a generic MCP client): paste the "system prompt for');
  log('a non-Claude agent" block from docs/agent-guide.md so the agent uses memory on');
  log('its own -- it does not have hooks.');
  log('');
  log('The steps above use the "memory" command. To make it run from any folder,');
  log('do this one-time step from memory-daemon/:  npm link');
  log('  (If you skip it, run the CLI as: node dist/cli/memory.js <command>.)');
  log('');
  log('Next steps:');
  log('  1. Start using it. On the first daemon start the embedding model');
  log('     downloads (about 130 MB); hybrid search is ready after that one-time');
  log('     warmup. Until it finishes, search is keyword-only.');
  log('  2. Check the install: memory doctor');
  log('  3. Try it: memory search "your question"');
}

/**
 * Seeding step: on a TTY, ask the setup questions and write the answers as first
 * real facts. Non-interactively, print the exact `memory add` commands instead,
 * so the user is never told memory is populated when it is only placeholder.
 */
async function seedStep(
  log: (line: string) => void,
  ask: (q: string) => Promise<string>,
  interactive: boolean,
  vaultPath: string,
): Promise<void> {
  if (interactive) {
    log('Two or three quick questions to seed your first memory (Enter skips any):');
    const facts: SeedFact[] = [];
    for (const q of SEED_QUESTIONS) {
      const answer = (await ask(q.question)).trim();
      if (answer) facts.push({ file: q.file, section: q.section, text: answer });
    }
    const written = await seedFacts(vaultPath, facts);
    if (written.length > 0) {
      log(`  seeded ${written.length} fact(s):`);
      for (const w of written) log(`    ${w.path_hint} / ${w.section}: ${w.text}`);
    } else {
      log('  (no facts entered; add them later with `memory add`)');
    }
    log('');
    return;
  }
  // Non-interactive: do not prompt, but make the next step unmistakable.
  log('Seed your first facts so the first session is not empty (real, provenance-tagged memory):');
  log('  memory add user Profile "Alice, backend engineer at Acme; works on payments."');
  log('  memory add memory Conventions "Commit messages in English, no AI attribution lines."');
  log('');
}

/**
 * Hooks step: decide whether to register the Claude Code hooks (--hooks /
 * --no-hooks, else ask on a TTY when Claude Code is detected, else default off),
 * then merge them into the settings file or print the block to paste by hand.
 */
async function hooksStep(
  log: (line: string) => void,
  confirm: (q: string) => Promise<boolean>,
  interactive: boolean,
  values: { hooks?: boolean | undefined; 'no-hooks'?: boolean | undefined; settings?: string | undefined },
): Promise<void> {
  const scripts = resolveHookScripts();
  const detection = detectClaudeCode(process.cwd());
  const settingsPath = values.settings
    ?? process.env['MEMORY_CLAUDE_SETTINGS']
    ?? detection.userSettings;

  // Resolve intent: explicit flags win; otherwise ask on a TTY when Claude Code
  // is present; otherwise stay off (never modify settings without consent).
  let wantHooks: boolean;
  if (values['no-hooks']) wantHooks = false;
  else if (values.hooks) wantHooks = true;
  else if (interactive && detection.detected) {
    wantHooks = await confirm('Claude Code detected. Register the memory hooks so it turns on automatically? [Y/n] ');
  } else wantHooks = false;

  if (!wantHooks) {
    printManualHooks(log, scripts);
    log('');
    return;
  }

  // Registering. If the settings file is missing, only create it after explicit
  // consent (an interactive yes, or a non-interactive --hooks); never silently.
  const exists = fs.existsSync(settingsPath);
  let createIfMissing = true;
  if (!exists && interactive) {
    createIfMissing = await confirm(`No settings file at ${settingsPath}. Create it? [Y/n] `);
  }

  const res = registerClaudeHooks({ settingsPath, scripts, createIfMissing });
  if (res.action === 'missing') {
    log(`No settings file at ${settingsPath}, and it was not created.`);
    printManualHooks(log, scripts);
    log('');
    return;
  }
  const events = [...new Set([...res.addedEvents, ...res.updatedEvents])];
  log(`Claude Code hooks ${res.action}: ${res.settingsPath}`);
  if (res.backupPath) log(`  backup written: ${res.backupPath}`);
  log(`  hooks wired: ${events.join(', ')}`);
  log('  Restart Claude Code (or start a new session) so the hooks load. Memory is now automatic.');
  log('');
}
