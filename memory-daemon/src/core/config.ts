import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { z } from 'zod';
import { configDir } from './paths.js';

/**
 * Layered configuration: non-personal defaults < config.local.yml at the root
 * of the memory-vault repo (kept in the project, outside Git via
 * .git/info/exclude) < the calling repo's .memory.yml marker < environment
 * variables. Legacy fallback: config.yml in the OS config dir.
 *
 * The OpenRouter API key (a secret) resolves separately, on a non-repo-bound
 * order so it can live outside the working tree (security finding #5). Highest
 * priority first: (a) the OPENROUTER_API_KEY environment variable; (b) a
 * config.yml in the OS config dir (off Git, ACL-locked); (c) the repo-root
 * config.local.yml (legacy fallback). No real key found => openrouter stays
 * undefined, capture is OFF, and nothing leaves the machine (the documented
 * safe default).
 */

/**
 * Path to config.local.yml at the repo root, resolved relative to THIS module
 * so a fresh clone works with no hardcoded machine paths. This file lives at
 * <repo>/memory-daemon/{src,dist}/core/config.{ts,js}; both build layouts sit
 * at the same depth, so three levels up is always the repo root.
 */
export const REPO_CONFIG = fileURLToPath(new URL('../../../config.local.yml', import.meta.url));

/** The literal config.example.yml ships in the api_key line; never a real key. */
const KEY_PLACEHOLDER = 'REPLACE_WITH_YOUR_OPENROUTER_KEY';

/**
 * Any api_key starting with one of these is an unfilled placeholder, not a key.
 * Matching by prefix (not one exact literal) closes a real leak path: a user
 * who uncomments api_key in the template without editing it must NOT silently
 * turn capture on and post session snippets to OpenRouter with a bad key.
 * 'COLE_' keeps the legacy Portuguese placeholder (COLE_A_CHAVE_AQUI) working
 * on configs written before the template moved to English.
 */
const PLACEHOLDER_KEY_PREFIXES = ['REPLACE_', 'COLE_'];

const ConfigFileSchema = z.object({
  vaults: z.record(z.string(), z.string()).optional(),
  default_vault: z.string().optional(),
  /**
   * Read-only folders indexed INTO a vault's search scope without living in the
   * vault. Born 2026-08-01: an external tool keeps its own
   * files and its own git, memory only reads them. Strict on shape: a typo'd
   * entry must fail the parse loudly, not index into the wrong scope.
   */
  external_roots: z.record(z.string(), z.object({
    path: z.string(),
    vault: z.string(),
  })).optional(),
  embeddings: z.object({
    enabled: z.boolean().optional(),
    model: z.string().optional(),
  }).optional(),
  openrouter: z.object({
    api_key: z.string().optional(),
    model: z.string().optional(),
  }).optional(),
  triage: z.object({
    backend: z.enum(['openrouter', 'claude-cli']).optional(),
    model: z.string().optional(),
    command: z.string().optional(),
  }).optional(),
}).loose();

/**
 * The repo marker: which vault this repo belongs to, and whether it also reads
 * the shared personal vault.
 *
 * `.loose()` keeps it TOLERANT: an extra key a person (or a future version) put
 * in the file must not make the marker unusable. `share_global` is typed
 * strictly on purpose, though. A value like `share_global: "true"` (a string) is
 * a real mistake, and silently reading it as "not shared" would hide the reason
 * the shared memory disappeared, while silently reading it as "shared" would
 * open a vault nobody invited. A wrong type therefore fails the parse, which
 * makes the marker malformed and produces the loud, actionable warning.
 */
const MarkerSchema = z.object({
  vault: z.string(),
  share_global: z.boolean().optional(),
}).loose();

export interface MemoryConfig {
  /** vault name -> absolute root. */
  vaults: Record<string, string>;
  defaultVault: string;
  /**
   * Registered read-only roots: name -> { path, vault }. Files under `path` are
   * indexed into `vault`'s READ scope under the synthetic index identity
   * `<vault>::<name>` (see vault-scope). The daemon never writes there, the backup job
   * never commits there, and every file indexes as third-party/untrusted no
   * matter what its frontmatter claims — an external file must not be able to
   * talk its way into the curated trust level.
   * Optional so a hand-built config (tests) reads as "no external roots";
   * loadConfig always fills it in.
   */
  externalRoots?: Record<string, { path: string; vault: string }> | undefined;
  embeddings: { enabled: boolean; model: string };
  /** Capture triage; undefined = capture turned off. */
  openrouter?: { apiKey: string; model: string } | undefined;
  /**
   * The ACTIVE triage backend, the single truth every consumer reads. Absent
   * means capture is off. `openrouter` needs the key above; `claude-cli` runs
   * the local Claude Code CLI on the owner's own account, so session text goes
   * to Anthropic instead of a third party, and no extra key is needed.
   * `command` optionally pins the CLI binary; absent means auto-resolve.
   */
  triage?: { backend: 'openrouter' | 'claude-cli'; model: string; command?: string | undefined } | undefined;
  /**
   * A plain-English problem found while loading, worth showing to a human but
   * not bad enough to refuse to start. Today it means: the repo's `.memory.yml`
   * could not be honoured (it names a vault that is not configured, or it does
   * not parse). Callers print it (CLI) or log it (daemon, MCP proxy) — see
   * printConfigWarning.
   */
  markerWarning?: string | undefined;
  /**
   * True when the repo marker asked for the shared `global` vault as well
   * (`share_global: true`). It is a READ permission and nothing else: a write
   * always lands in this process's own vault. Absent means not shared, which is
   * the default for every repo. See `ambientReadScope`.
   */
  shareGlobal?: boolean | undefined;
  /**
   * True when this process found a `.memory.yml` it could NOT honour. It is the
   * machine-readable half of markerWarning, and it makes READS fail closed: an
   * unusable marker means we do not know whose repo this is, so there is nothing
   * safe to read at all. See `ambientReadScope`.
   * WRITES fail closed on the same flag, by refusing instead of picking a vault
   * (see `resolveMemoryFile`): every curated file now lives in the caller's own
   * vault, so an unknown caller has no file it may touch.
   * Absent (undefined) covers both "no marker" and "a marker we honoured".
   */
  markerBroken?: boolean | undefined;
  /**
   * Absolute path of the `.memory.yml` that could not be honoured. Set together
   * with markerBroken. Error hints and the search notice name this file, so the
   * person reading them knows exactly which file to fix.
   */
  markerFile?: string | undefined;
  /**
   * The vault name that unusable marker asked for, when it had one (absent when
   * the file did not parse). It is written in the caller's OWN repo, so it is
   * safe to echo back; the names of other configured vaults are not.
   */
  markerVault?: string | undefined;
}

/**
 * Non-personal defaults only. No vault paths ship in the code: the user's
 * vaults come entirely from config.local.yml (or the OS config dir). An empty
 * vaults map here means a fresh clone with no config fails loudly in the
 * first-run guard at the end of loadConfig, instead of booting against a
 * missing directory.
 */
const MACHINE_DEFAULTS: MemoryConfig = {
  vaults: {},
  defaultVault: 'global',
  externalRoots: {},
  embeddings: { enabled: true, model: 'multilingual-e5-small' },
};

function readYamlFile(file: string): unknown {
  try {
    return yaml.load(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** One candidate key source; either field may be absent (exactOptionalPropertyTypes). */
type OpenRouterSource = { apiKey?: string | undefined; model?: string | undefined };

/** The openrouter block from a yaml config file, or empty if it is absent/invalid. */
function readOpenRouterBlock(file: string): OpenRouterSource {
  const parsed = ConfigFileSchema.safeParse(readYamlFile(file));
  if (!parsed.success) return {};
  const or = parsed.data.openrouter;
  return { apiKey: or?.api_key, model: or?.model };
}

/** The triage block from a yaml config file, or undefined when absent/invalid. */
function readTriageBlock(file: string): { backend?: string | undefined; model?: string | undefined; command?: string | undefined } | undefined {
  const parsed = ConfigFileSchema.safeParse(readYamlFile(file));
  return parsed.success ? parsed.data.triage : undefined;
}

/** A key counts only when it is present and is not an unfilled placeholder. */
function isRealKey(key: string | undefined): key is string {
  if (!key) return false;
  // The exact shipped literal and any placeholder-prefixed value mean "no key
  // was set yet"; treating them as real would enable capture with a bad key.
  if (key === KEY_PLACEHOLDER) return false;
  return !PLACEHOLDER_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * What the walk up from a cwd found in `.memory.yml`.
 *
 * The three cases must stay apart, because the READ scope treats them
 * differently. No marker means the repo simply has no vault of its own, so the
 * config default is the honest answer. A marker that exists but cannot be used
 * means we do NOT know whose repo this is, and falling back to any other vault
 * would hand this repo memory that was never meant for it. See
 * `ambientReadScope` and `resolveSessionScope` for the rule built on top of this.
 */
export type ProjectMarker =
  /** No `.memory.yml` anywhere above the cwd. */
  | { kind: 'none' }
  /** A `.memory.yml` that does not parse, or has no `vault:` key. */
  | { kind: 'malformed'; file: string }
  /** A `.memory.yml` that names a vault. The name may still be unknown to config. */
  | {
      kind: 'named';
      vault: string;
      /** `share_global: true` in the file: this repo also READS the shared vault. */
      shareGlobal: boolean;
      file: string;
    };

/**
 * Walks up from cwd to the root looking for the repo's .memory.yml marker, and
 * reports WHICH of the three cases happened. It never throws: a marker a human
 * broke by hand must not stop the CLI or the daemon.
 */
export function readProjectMarker(cwd: string): ProjectMarker {
  let dir = path.resolve(cwd);
  for (;;) {
    const file = path.join(dir, '.memory.yml');
    if (fs.existsSync(file)) {
      const parsed = MarkerSchema.safeParse(readYamlFile(file));
      // The first marker found wins; a broken one is reported, never skipped in
      // favour of a marker further up, which would silently pick another vault.
      return parsed.success
        ? {
            kind: 'named',
            vault: parsed.data.vault,
            // Absent means NOT shared. Sharing the personal vault is an opt-in,
            // so only the literal `true` may turn it on.
            shareGlobal: parsed.data.share_global === true,
            file,
          }
        : { kind: 'malformed', file };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return { kind: 'none' };
    dir = parent;
  }
}

/**
 * The vault name a marker asks for, or undefined when there is no usable one.
 * Thin wrapper over readProjectMarker for callers that do not need to tell a
 * missing marker from a broken one.
 */
export function findProjectMarker(cwd: string): { vault: string } | undefined {
  const marker = readProjectMarker(cwd);
  return marker.kind === 'named' ? { vault: marker.vault } : undefined;
}

export interface LoadConfigOptions {
  /** Explicit config.yml path (tests). */
  configPath?: string;
  /** Directory to search .memory.yml from; omitted skips the search. */
  cwd?: string;
}

/**
 * The repo-root config.local.yml candidate. Defaults to the module-resolved
 * REPO_CONFIG, but MEMORY_REPO_CONFIG overrides it so a test can point the
 * repo-local branch at a temp file (and thus never depends on whether a real
 * config.local.yml happens to exist on the machine running the tests).
 */
function repoConfigCandidate(): string {
  return process.env['MEMORY_REPO_CONFIG'] ?? REPO_CONFIG;
}

/** Which resolution rule chose the active config file (finding 5). */
export type ConfigOrigin = 'explicit' | 'env' | 'repo_local' | 'os_config_dir';

export interface ConfigSource {
  /** Absolute path to the config file loadConfig will read (whether or not it exists yet). */
  path: string;
  /** Which rule chose it, so a human can see WHY this file wins. */
  origin: ConfigOrigin;
  /** true when that file is present on disk. */
  exists: boolean;
}

/**
 * Resolves WHICH config file loadConfig reads, and why — the single source of
 * truth for config precedence (finding 5). Order, highest first: an explicit
 * path, the MEMORY_CONFIG env var, a repo-root config.local.yml, then the OS
 * config dir file. Pure path logic; it never throws. `doctor` and `init` use it
 * to show the file that actually wins, so a vault re-scoped in a shadowed file
 * is not silently ignored.
 */
export function resolveConfigSource(opts: LoadConfigOptions = {}): ConfigSource {
  // An explicit path (tests, callers) beats everything.
  if (opts.configPath) {
    return { path: opts.configPath, origin: 'explicit', exists: fs.existsSync(opts.configPath) };
  }
  // MEMORY_CONFIG lets the secret/config live anywhere, outside the repo tree.
  const env = process.env['MEMORY_CONFIG'];
  if (env) return { path: env, origin: 'env', exists: fs.existsSync(env) };
  // A present repo-root config.local.yml shadows the OS config dir file. This is
  // the exact footgun a user hits: `memory init` writes the OS-dir file, but if
  // a config.local.yml exists here it is read instead.
  const repo = repoConfigCandidate();
  if (fs.existsSync(repo)) return { path: repo, origin: 'repo_local', exists: true };
  // The OS config dir file is the fallback (the one `memory init` writes to).
  const osFile = path.join(configDir(), 'config.yml');
  return { path: osFile, origin: 'os_config_dir', exists: fs.existsSync(osFile) };
}

/**
 * Shows the config's non-fatal warning, if there is one. Kept here so every
 * caller words it the same way; `write` defaults to stderr so it never mixes
 * into command output a script may parse (or into the MCP protocol on stdout).
 */
export function printConfigWarning(
  config: MemoryConfig,
  write: (line: string) => void = (line) => process.stderr.write(line + '\n'),
): void {
  if (config.markerWarning) write(`warning: ${config.markerWarning}`);
}

/** One plain-English label for where the active config came from (finding 5). */
export function describeConfigOrigin(origin: ConfigOrigin): string {
  switch (origin) {
    case 'explicit': return 'given explicitly';
    case 'env': return 'from the MEMORY_CONFIG environment variable';
    case 'repo_local': return 'repo-root config.local.yml';
    case 'os_config_dir': return 'OS config directory';
  }
}

export function loadConfig(opts: LoadConfigOptions = {}): MemoryConfig {
  const cfg: MemoryConfig = {
    vaults: { ...MACHINE_DEFAULTS.vaults },
    defaultVault: MACHINE_DEFAULTS.defaultVault,
    externalRoots: { ...MACHINE_DEFAULTS.externalRoots },
    embeddings: { ...MACHINE_DEFAULTS.embeddings },
  };

  // Read the file resolveConfigSource picks, so the precedence doctor/init show
  // and the precedence loadConfig actually uses can never drift apart.
  const file = resolveConfigSource(opts).path;
  const rawCfg = readYamlFile(file);
  if (rawCfg !== undefined) {
    const parsed = ConfigFileSchema.safeParse(rawCfg);
    if (!parsed.success) {
      throw new Error(`config.yml invalid at ${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    // Replaces (does not merge): whoever writes config.yml takes the whole list.
    // Merging would keep an unwanted default vault being indexed.
    if (parsed.data.vaults) cfg.vaults = { ...parsed.data.vaults };
    if (parsed.data.default_vault) cfg.defaultVault = parsed.data.default_vault;
    if (parsed.data.external_roots) cfg.externalRoots = { ...parsed.data.external_roots };
    if (parsed.data.embeddings?.enabled !== undefined) cfg.embeddings.enabled = parsed.data.embeddings.enabled;
    if (parsed.data.embeddings?.model) cfg.embeddings.model = parsed.data.embeddings.model;
  }

  // OpenRouter key resolution (security finding #5): env var beats any file, so
  // the secret need not sit in the repo tree. See the header comment for the
  // full order. The env var wins even when a file also holds a key.
  const orSources: OpenRouterSource[] = [
    { apiKey: process.env['OPENROUTER_API_KEY'], model: process.env['OPENROUTER_MODEL'] },
    readOpenRouterBlock(path.join(configDir(), 'config.yml')),
    readOpenRouterBlock(file),
  ];
  const orHit = orSources.find((s) => isRealKey(s.apiKey));
  if (orHit) {
    cfg.openrouter = { apiKey: orHit.apiKey!, model: orHit.model ?? 'openai/gpt-oss-120b' };
  }

  // The active triage backend, one truth for every consumer. An explicit
  // `triage: backend: claude-cli` wins and needs no key; anything else falls
  // back to OpenRouter when (and only when) a real key resolved above.
  const triageBlock = readTriageBlock(file);
  if (triageBlock?.backend === 'claude-cli') {
    cfg.triage = {
      backend: 'claude-cli',
      model: triageBlock.model ?? 'haiku',
      command: triageBlock.command,
    };
  } else if (cfg.openrouter) {
    cfg.triage = { backend: 'openrouter', model: cfg.openrouter.model };
  }

  // Env: MEMORY_VAULT_<NAME>=path adds or overrides a vault.
  for (const [key, value] of Object.entries(process.env)) {
    const m = /^MEMORY_VAULT_([A-Z0-9_]+)$/.exec(key);
    if (m && value) cfg.vaults[m[1]!.toLowerCase()] = value;
  }
  if (process.env['MEMORY_DEFAULT_VAULT']) cfg.defaultVault = process.env['MEMORY_DEFAULT_VAULT'];

  // The repo marker chooses the process's default vault (e.g. every repo of one
  // client points at that client's vault).
  if (opts.cwd) {
    const marker = readProjectMarker(opts.cwd);
    if (marker.kind === 'named' && cfg.vaults[marker.vault]) {
      cfg.defaultVault = marker.vault;
      // The opt-in that lets this repo ALSO read the shared vault. Reads only:
      // a write from here still lands in marker.vault.
      cfg.shareGlobal = marker.shareGlobal;
    } else if (marker.kind === 'named') {
      // A marker naming an unknown vault used to be dropped in silence, and the
      // process kept the default vault — which in a multi-client setup is
      // ANOTHER client's vault. Never silent: say what was asked for, what
      // happens now, and how to fix it. markerBroken makes every read here find
      // nothing (the shared vault needs an invitation this file cannot express)
      // and refuses every curated write, so a note cannot land in a wrong vault.
      cfg.markerBroken = true;
      cfg.markerFile = marker.file;
      cfg.markerVault = marker.vault;
      cfg.markerWarning =
        `This repo's .memory.yml (${marker.file}) asks for the vault '${marker.vault}', but that vault `
        + `is not configured. Until you fix it, a search here reads no vault at all and finds nothing, `
        + `and every write from here is refused, so a note cannot land in the wrong vault. `
        + `Configured vaults: ${Object.keys(cfg.vaults).join(', ') || '(none)'}. `
        + `Add it with: memory vault add ${marker.vault} <path>`;
    } else if (marker.kind === 'malformed') {
      // A marker a human broke by hand is the same danger as a typo'd name: we
      // cannot tell whose repo this is, so reads and writes both fail closed and
      // the human is told. Staying silent here was the older behaviour and it hid
      // the problem.
      cfg.markerBroken = true;
      cfg.markerFile = marker.file;
      cfg.markerWarning =
        `This repo's .memory.yml could not be read: ${marker.file}. It must be valid YAML with a `
        + `'vault: <name>' line. Until you fix it, a search here reads no vault at all and finds `
        + `nothing, and every write from here is refused, so a note cannot land in the wrong vault. `
        + `Fix the file, or delete it to use the default vault '${cfg.defaultVault}'.`;
    }
  }

  // First-run guard. A fresh clone has no vaults; an old config can name a
  // default vault that is absent or points at a folder that no longer exists.
  // Any of these must fail loudly here: booting against a missing directory
  // makes search silently return empty, which looks like data loss.
  if (Object.keys(cfg.vaults).length === 0) {
    throw new Error(
      'No vault configured. Run `memory init` to set this up, or add a vaults '
      + 'entry to config.local.yml (or the OS config dir), then start again.',
    );
  }
  const vaultPath = cfg.vaults[cfg.defaultVault];
  if (!vaultPath) {
    throw new Error(
      `default_vault '${cfg.defaultVault}' is not one of the configured vaults `
      + `(${Object.keys(cfg.vaults).join(', ')}). Fix default_vault in config.local.yml `
      + '(or the OS config dir), then start again.',
    );
  }
  if (!fs.existsSync(vaultPath)) {
    throw new Error(
      `Vault '${cfg.defaultVault}' points to a path that does not exist: ${vaultPath}. `
      + 'Fix the vaults entry in config.local.yml (or the OS config dir), then start again.',
    );
  }

  // External roots are validated LAST, against the final vault list (env vars
  // above may still add vaults). Both problems fail loudly: a root whose owner
  // vault is a typo would otherwise index into a scope nobody reads, and a name
  // outside the vault charset would break the `<vault>::<name>` identity.
  for (const [name, root] of Object.entries(cfg.externalRoots ?? {})) {
    const nameProblem = externalRootNameProblem(name);
    if (nameProblem) {
      throw new Error(`external_roots entry '${name}': ${nameProblem}`);
    }
    if (!cfg.vaults[root.vault]) {
      throw new Error(
        `external_roots entry '${name}' names the vault '${root.vault}', which is not configured `
        + `(configured vaults: ${Object.keys(cfg.vaults).join(', ')}). Fix the vault name in `
        + 'config.local.yml (or the OS config dir), then start again.',
      );
    }
  }
  return cfg;
}

/**
 * Same charset rule as a vault name (letters, digits, '-', '_'), kept as a
 * LOCAL copy on purpose: importing vault-scope here would put the config module
 * under a module that imports its types, and this one regex is not worth the
 * tangle. The `::` separator of the synthetic index identity can never appear
 * in a name this regex accepts, which is what keeps the identity unambiguous.
 */
function externalRootNameProblem(name: string): string | undefined {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name)
    ? undefined
    : 'the name may use only letters, digits, "-" and "_", must start with a letter or digit, and may be at most 32 characters long.';
}
