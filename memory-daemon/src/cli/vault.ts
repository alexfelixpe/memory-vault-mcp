import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  loadConfig, resolveConfigSource, describeConfigOrigin, printConfigWarning,
  type ConfigSource, type MemoryConfig,
} from '../core/config.js';
import { detectEol, applyEol } from '../core/text/eol.js';
import { atomicWriteMarkdown } from '../core/atomic-write.js';
import {
  vaultNameProblem, ambientReadScope, describeReadScope, markerFixHint, GLOBAL_VAULT,
} from '../core/vault-scope.js';
import { PROJECT_SEED, SEED_FILES } from './init.js';

/**
 * `memory vault add|list|seed`: manage the configured vaults without losing any.
 *
 * Before this command the only way to register a vault was `memory init --vault
 * ... --force`, which REPLACES the whole vaults map — adding a second client
 * would silently drop the first one. These verbs merge instead, and they edit
 * the config file that is actually in effect (a repo-root config.local.yml
 * shadows the OS-dir file), so the change cannot land in an ignored file.
 *
 * `seed` exists for the vaults registered BEFORE the curated files became part of
 * `add`. Those vaults hold no USER.md, MEMORY.md or PROJECT.md, so their first
 * write answers FILE_NOT_FOUND. `seed` creates only what is missing, and `list`
 * marks the vaults that need it, so the gap is visible before it bites.
 */

/** A problem a human caused and a human can fix: printed as one line, no stack. */
export class VaultCommandError extends Error {}

/** Injectable output, so tests read the printed lines instead of the console. */
export interface VaultDeps {
  out(line: string): void;
  /** Config file to edit; defaults to the one loadConfig actually reads. */
  source?: ConfigSource | undefined;
  /** Directory the repo marker is searched from (defaults to the real cwd). */
  cwd?: string | undefined;
}

/** The yaml scalar for a path: JSON quoting is valid yaml and survives backslashes. */
function yamlPath(value: string): string {
  return JSON.stringify(value);
}

/**
 * Returns the config text with one vault added, leaving every other byte alone.
 *
 * It is a surgical text insert, NOT a parse-and-rewrite, and that is on purpose:
 * the active config file may hold the user's OpenRouter key and hand-written
 * comments, and a yaml round-trip would drop the comments and reformat the file.
 * Throws VaultCommandError when the file's shape is one this cannot edit safely.
 */
export function addVaultToConfigText(raw: string, name: string, vaultPath: string): string {
  // Parse first, purely to validate: an unreadable config must fail before we
  // append text to it and make it worse.
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (e) {
    throw new VaultCommandError(`The config file is not valid YAML, so it was not changed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed !== undefined && parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new VaultCommandError('The config file does not hold a YAML mapping, so it was not changed. Fix the file by hand.');
  }
  const root = (parsed ?? {}) as Record<string, unknown>;
  const existing = root['vaults'];
  if (existing !== undefined && existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
    if (Object.prototype.hasOwnProperty.call(existing, name)) {
      throw new VaultCommandError(
        `A vault named '${name}' already exists in this config file (it points to ${String((existing as Record<string, unknown>)[name])}). `
        + 'Pick another name, or edit that line by hand to change the path.',
      );
    }
  } else if (existing !== undefined && existing !== null) {
    throw new VaultCommandError('The "vaults" key in the config file is not a mapping. Fix it by hand, then run this again.');
  }

  const eol = detectEol(raw);
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const entry = (indent: string): string => `${indent}${name}: ${yamlPath(vaultPath)}`;

  // Block style ("vaults:" alone on its line) is what every config we write uses.
  const anchor = lines.findIndex((line) => /^vaults:\s*(#.*)?$/.test(line));
  if (anchor === -1) {
    // No vaults key at all: start the block at the end of the file. A second
    // "vaults:" key would be a duplicate key, so this only runs when there is none.
    if (existing !== undefined && existing !== null) {
      throw new VaultCommandError(
        'The "vaults" key is written on one line (flow style), which this command does not edit. '
        + `Add this line under a block-style "vaults:" key by hand:  ${name}: ${yamlPath(vaultPath)}`,
      );
    }
    const body = [...lines];
    while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
    body.push('vaults:', entry('  '), '');
    return applyEol(body.join('\n'), eol);
  }

  // Walk the block: its entries are the indented (or blank) lines after the key.
  let last = anchor;
  let indent = '  ';
  let sawEntry = false;
  for (let i = anchor + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;              // a blank line may sit inside the block
    if (!/^\s/.test(line)) break;                  // back to column 0: the block ended
    const m = /^(\s+)/.exec(line);
    if (!sawEntry && m) { indent = m[1]!; sawEntry = true; }
    last = i;
  }
  const out = [...lines];
  out.splice(last + 1, 0, entry(indent));
  return applyEol(out.join('\n'), eol);
}

/** One curated file a vault must hold: its name and the text to write when absent. */
type CuratedSeed = readonly [name: string, body: string];

/**
 * The curated files THIS vault must hold, with the seed text for each one.
 *
 * Every vault is self-contained: it holds its own USER.md, MEMORY.md and
 * PROJECT.md, because reads no longer reach the shared vault unless the repo asks
 * for it. Without these files the vault is registered but unusable: the first
 * write answers FILE_NOT_FOUND. The seed text is the same one `memory init` uses,
 * so the sections carry the `<!-- auto -->` marker that agent writes need.
 *
 * The shared `global` vault is the exception, and it needs no PROJECT.md: it is
 * the personal layer, not a project, and `resolveMemoryFile` refuses
 * `file: 'project'` there. A PROJECT.md in it could never be written to, so
 * creating one, or reporting it as missing, would only mislead.
 */
function curatedSeedsFor(vaultName: string): CuratedSeed[] {
  const seeds: CuratedSeed[] = [...Object.entries(SEED_FILES)];
  if (vaultName !== GLOBAL_VAULT) seeds.push(['PROJECT.md', PROJECT_SEED]);
  return seeds;
}

/**
 * The curated files this vault does NOT have yet, in the order they are created.
 * An empty array means the vault can take a write. `memory vault list` uses it to
 * mark the vaults that still need `memory vault seed`.
 */
export function missingCuratedFiles(vaultRoot: string, vaultName: string): string[] {
  return curatedSeedsFor(vaultName)
    .filter(([name]) => !fs.existsSync(path.join(vaultRoot, name)))
    .map(([name]) => name);
}

/**
 * Creates the curated files this vault is missing, and reports what happened to
 * each one. Shared by `memory vault add` (a new vault) and `memory vault seed`
 * (a vault registered before the curated files existed), so both write exactly
 * the same content.
 *
 * An existing file is NEVER overwritten. Registering a folder that is already an
 * Obsidian vault is a normal case, and that person's own files must survive.
 */
async function seedCuratedFiles(
  vaultRoot: string,
  vaultName: string,
): Promise<Array<{ name: string; state: 'created' | 'kept' }>> {
  const report: Array<{ name: string; state: 'created' | 'kept' }> = [];
  for (const [name, body] of curatedSeedsFor(vaultName)) {
    const file = path.join(vaultRoot, name);
    if (fs.existsSync(file)) {
      report.push({ name, state: 'kept' });
      continue;
    }
    // Atomic, like every other file this project writes.
    await atomicWriteMarkdown(file, body);
    report.push({ name, state: 'created' });
  }
  return report;
}

/**
 * The config the read verbs (`list`, `seed`) work from. It is the config that is
 * really in effect, marker included, so what these commands report is what a
 * search or a write from this same folder would really do.
 *
 * loadConfig's first-run guard throws a PLAIN Error (no vault configured, a
 * default_vault that is not in the list, or a vault whose folder is gone). The
 * CLI does not recognise that type, so it reached the user as a stack trace. It
 * also fires on the DEFAULT vault, which may not be the vault the person named,
 * so the raw message alone reads like the wrong answer. Rethrowing as
 * VaultCommandError gives one clean line, and the guard's own text is kept
 * because it already names the vault and the file to fix. It is a rethrow, never
 * a fallback: the command still fails and the exit code stays non-zero.
 */
function loadConfigHere(deps: VaultDeps): MemoryConfig {
  try {
    return loadConfig({ cwd: deps.cwd ?? process.cwd() });
  } catch (e) {
    throw new VaultCommandError(
      'The vault list in your config could not be read, so this command did nothing. '
      + (e instanceof Error ? e.message : String(e)),
    );
  }
}

/** The plain-English steps a new vault still needs after the config edit. */
function printNextSteps(deps: VaultDeps, name: string): void {
  deps.out('');
  deps.out('Three more steps to make it work:');
  deps.out('  1. The daemon reads the config only when it starts. Restart it:');
  deps.out('       memory daemon stop');
  deps.out('       memory daemon start');
  deps.out(`  2. Build the search index for the new vault:  memory index --vault ${name}`);
  deps.out('  3. Point a repo at this vault: create a file named .memory.yml at the');
  deps.out(`     root of that repo, containing this one line:  vault: ${name}`);
  deps.out('');
  deps.out(`An agent working in that repo then reads only '${name}'. It starts with empty`);
  deps.out('memory, and that is on purpose: nothing from your other vaults is visible there.');
  deps.out('');
  deps.out(`To let that repo ALSO read your shared '${GLOBAL_VAULT}' vault, add a second line`);
  deps.out('to its .memory.yml:');
  deps.out(`       vault: ${name}`);
  deps.out('       share_global: true');
  deps.out(`Sharing is for reading only. A write from that repo still lands in '${name}'.`);
}

/** memory vault add <name> <path> — merge one vault into the active config file. */
export async function cmdVaultAdd(positionals: string[], deps: VaultDeps): Promise<void> {
  const name = positionals[0];
  const givenPath = positionals.slice(1).join(' ').trim();
  if (!name || !givenPath) {
    throw new VaultCommandError('usage: memory vault add <name> <path>');
  }
  const problem = vaultNameProblem(name);
  if (problem) throw new VaultCommandError(problem);

  // The path must already exist: a typo would otherwise create a vault that
  // indexes nothing, and loadConfig refuses to start on a missing default vault.
  const abs = path.resolve(givenPath);
  if (!fs.existsSync(abs)) {
    throw new VaultCommandError(`That folder does not exist: ${abs}. Create it first, then run this again.`);
  }
  if (!fs.statSync(abs).isDirectory()) {
    throw new VaultCommandError(`That path is a file, not a folder: ${abs}. A vault is a folder of markdown notes.`);
  }

  // Edit the file that is really in effect. Writing to a shadowed file is the
  // exact footgun `memory init` already warns about (finding 5).
  const source = deps.source ?? resolveConfigSource();
  if (!source.exists) {
    throw new VaultCommandError(
      `There is no config file yet at ${source.path}. Run \`memory init\` first, then add more vaults with this command.`,
    );
  }
  const raw = fs.readFileSync(source.path, 'utf8');
  const next = addVaultToConfigText(raw, name, abs);
  // Atomic (tmp + fsync + rename), like every other file this project writes:
  // this file can hold the user's OpenRouter key, so a half-written config would
  // be worse than no change at all.
  await atomicWriteMarkdown(source.path, next);

  // Only after the config edit succeeded: a vault that is not registered has no
  // reason to gain a curated file.
  const seeds = await seedCuratedFiles(abs, name);

  deps.out(`Added vault '${name}' -> ${abs}`);
  deps.out(`  config file changed: ${source.path}  (${describeConfigOrigin(source.origin)})`);
  deps.out('  Vaults already in that file were kept.');
  const created = seeds.filter((s) => s.state === 'created').map((s) => s.name);
  const kept = seeds.filter((s) => s.state === 'kept').map((s) => s.name);
  if (created.length > 0) deps.out(`  created ${created.join(', ')} in that folder`);
  if (kept.length > 0) deps.out(`  kept the ${kept.join(', ')} already in that folder (not overwritten)`);
  printNextSteps(deps, name);
}

/**
 * memory vault seed <name> — create the curated files an already-registered
 * vault is missing.
 *
 * `memory vault add` seeds a vault it registers, but every vault registered
 * before that change has no USER.md, MEMORY.md or PROJECT.md, and its first write
 * answers FILE_NOT_FOUND. This is the fix, and it is safe to run twice: it only
 * ever creates what is absent, and reports each file either way.
 */
export async function cmdVaultSeed(positionals: string[], deps: VaultDeps): Promise<void> {
  const name = positionals[0];
  if (!name) throw new VaultCommandError('usage: memory vault seed <name>');

  // Only a vault the config already knows: this command creates files inside a
  // folder, so guessing a path from a typo'd name would write into the wrong one.
  const config = loadConfigHere(deps);
  const root = config.vaults[name];
  if (!root) {
    const known = Object.keys(config.vaults);
    throw new VaultCommandError(
      `There is no vault named '${name}' in the config. `
      + `Configured vaults: ${known.length > 0 ? known.join(', ') : '(none)'}. `
      + `Register a new one with: memory vault add ${name} <path>`,
    );
  }
  // A path that is gone (a moved or deleted folder) must be a refusal, not a
  // silent mkdir: creating it here would hide the move and leave the real notes
  // behind in the old folder.
  if (!fs.existsSync(root)) {
    throw new VaultCommandError(
      `The folder of vault '${name}' does not exist: ${root}. `
      + 'Create that folder, or fix its path in the config, then run this again.',
    );
  }
  if (!fs.statSync(root).isDirectory()) {
    throw new VaultCommandError(
      `Vault '${name}' points at a file, not a folder: ${root}. A vault is a folder of markdown notes.`,
    );
  }

  const seeds = await seedCuratedFiles(root, name);
  deps.out(`Vault '${name}' -> ${root}`);
  for (const seed of seeds) {
    deps.out(`  ${seed.name.padEnd(12)}${seed.state === 'created' ? 'created' : 'already there, kept'}`);
  }
  deps.out('');
  if (seeds.some((s) => s.state === 'created')) {
    deps.out(`This vault can take writes now. Run \`memory index --vault ${name}\` so the new`);
    deps.out('files are searchable right away.');
  } else {
    deps.out('Nothing was missing, so no file changed. This vault already had every curated file.');
  }
}

/** memory vault list — every configured vault, the default one, and where they come from. */
export function cmdVaultList(deps: VaultDeps): void {
  const source = deps.source ?? resolveConfigSource();
  deps.out(`config file: ${source.path}  (${describeConfigOrigin(source.origin)})${source.exists ? '' : '  -- does not exist yet'}`);

  const config = loadConfigHere(deps);
  printConfigWarning(config, deps.out);
  deps.out('');
  deps.out('vaults:');
  // Set by any vault that has no curated file yet, so the fix is named once at
  // the end instead of on every line.
  let anyMissing = false;
  for (const [name, root] of Object.entries(config.vaults)) {
    const flags: string[] = [];
    if (name === config.defaultVault) flags.push('default here');
    // A MEMORY_VAULT_<NAME> environment variable overrides the file, so say when
    // a line the user is reading does not come from the file they were shown.
    if (process.env[`MEMORY_VAULT_${name.toUpperCase()}`]) flags.push('from the MEMORY_VAULT_ environment variable');
    if (!fs.existsSync(root)) {
      flags.push('FOLDER DOES NOT EXIST');
    } else {
      // A vault registered before `memory vault add` seeded these files has none
      // of them, and its first write fails. Say it here, where the person is
      // already looking, instead of letting the error message be the first news.
      const missing = missingCuratedFiles(root, name);
      if (missing.length > 0) {
        anyMissing = true;
        flags.push(`missing ${missing.join(', ')}`);
      }
    }
    deps.out(`  ${name.padEnd(12)} ${root}${flags.length > 0 ? `   [${flags.join('; ')}]` : ''}`);
  }
  if (anyMissing) {
    deps.out('A vault marked "missing" cannot take a write yet. Create those files with:');
    deps.out('  memory vault seed <name>');
  }
  deps.out('');
  // ambientReadScope, not the raw default: this is the command a person runs to
  // find out what this folder can see, so it must show the vaults a search here
  // really reads, and say whether the shared vault is one of them and why.
  const here = ambientReadScope(config);
  deps.out(`Vault for this folder: ${here.vault ?? '(none)'}`);
  deps.out(describeReadScope(here));
  if (config.markerBroken) {
    deps.out(`This folder's memory marker could not be used, so it has no vault at all: a search here`);
    deps.out('finds nothing and every write from here is refused.');
    deps.out(`  ${markerFixHint(config)}`);
  }
  deps.out('A write from this folder always lands in this folder\'s own vault, never in another one.');
  deps.out('Use `memory search "..." --vault all` to search every vault at once.');
  deps.out('Add one with: memory vault add <name> <path>');
}

/** memory vault — dispatch add / list / seed. */
export async function cmdVault(args: string[], deps: VaultDeps): Promise<void> {
  const [action, ...rest] = args;
  if (action === 'add') return cmdVaultAdd(rest, deps);
  if (action === 'seed') return cmdVaultSeed(rest, deps);
  if (action === 'list' || action === undefined) { cmdVaultList(deps); return; }
  throw new VaultCommandError(
    `invalid action '${action}'. Use: memory vault list | memory vault add <name> <path> `
    + '| memory vault seed <name>',
  );
}
