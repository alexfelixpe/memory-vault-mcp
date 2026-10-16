import fs from 'node:fs';
import { configDir, dataDir, cacheDir, indexRootDir } from '../core/paths.js';
import { tokenPath } from '../core/auth-token.js';
import { REPO_CONFIG, type MemoryConfig } from '../core/config.js';
import { resolveMcpServerJs } from './init.js';
import { unregisterClaudeHooks, type UnregisterResult } from './hooks-register.js';

/**
 * `memory uninstall` — remove the throwaway/system footprint cleanly while
 * treating the user's vault as their data (kept by default). Split from
 * memory.ts as a PURE worker: it takes explicit paths, deletes them, unregisters
 * the hooks, and returns a structured report. It never prompts, never stops the
 * daemon, and never reads process.cwd() — so tests point every path at a temp
 * dir and the developer's real setup is untouchable.
 *
 * What is "system footprint" (safe to delete, all rebuildable):
 *   - the SQLite index dir, the auth token, the model cache, the logs;
 *   - the config file in the OS config dir.
 * What is the user's data (kept unless an explicit flag opts in):
 *   - the vault(s) and their .memory/backups/;
 *   - the repo-root config.local.yml (a checked-out working file).
 */

/** One removable path with a human label; `existed` records whether it was there. */
export interface FootprintItem {
  label: string;
  path: string;
}

/** The set of system paths uninstall may delete. */
export interface UninstallTargets {
  indexDir: string;
  tokenFile: string;
  modelCache: string;
  logsDir: string;
  configFile: string;
  /** Repo-root config.local.yml; deleted only when purgeRepoConfig is set. */
  repoConfigFile: string;
}

/**
 * Resolves the real system footprint from the per-OS path helpers (each honors
 * its MEMORY_*_DIR env override, so this is still redirectable in a subprocess).
 * The CLI uses this; hermetic tests pass explicit targets instead.
 */
export function resolveUninstallTargets(): UninstallTargets {
  return {
    indexDir: indexRootDir(),
    tokenFile: tokenPath(),
    modelCache: cacheDir(),
    logsDir: `${dataDir()}/logs`,
    configFile: `${configDir()}/config.yml`,
    repoConfigFile: REPO_CONFIG,
  };
}

export interface UninstallOptions {
  targets: UninstallTargets;
  /** Vault roots (name -> path). Kept unless purgeVault. */
  vaults: MemoryConfig['vaults'];
  /** settings.json to unregister the hooks from. */
  settingsPath: string;
  /** Also delete the vault(s) and their backups. Requires strong confirmation upstream. */
  purgeVault?: boolean | undefined;
  /** Also delete the repo-root config.local.yml. Off by default (a working file). */
  purgeRepoConfig?: boolean | undefined;
}

export interface RemovedRecord extends FootprintItem {
  /** true when the path existed and was deleted; false when it was already absent. */
  existed: boolean;
}

export interface UninstallResult {
  removed: RemovedRecord[];
  kept: FootprintItem[];
  hooks: UnregisterResult;
  /** The MCP server entry the user must remove from their agent config by hand. */
  mcpServerJs: string;
}

/** Deletes a file or directory tree if present; reports whether it existed. */
function removePath(label: string, target: string): RemovedRecord {
  const existed = fs.existsSync(target);
  if (existed) fs.rmSync(target, { recursive: true, force: true, maxRetries: 5 });
  return { label, path: target, existed };
}

/**
 * Does the removal and returns the report. Order is deliberate: the model cache
 * and index are large and rebuildable; the config comes last so a crash midway
 * still leaves a usable config to retry from.
 */
export function runUninstall(opts: UninstallOptions): UninstallResult {
  const t = opts.targets;
  const removed: RemovedRecord[] = [];

  removed.push(removePath('SQLite index', t.indexDir));
  removed.push(removePath('auth token', t.tokenFile));
  removed.push(removePath('model cache', t.modelCache));
  removed.push(removePath('logs', t.logsDir));
  removed.push(removePath('config (OS config dir)', t.configFile));
  if (opts.purgeRepoConfig) removed.push(removePath('config.local.yml (repo root)', t.repoConfigFile));

  const kept: FootprintItem[] = [];
  if (opts.purgeVault) {
    for (const [name, root] of Object.entries(opts.vaults)) {
      removed.push(removePath(`vault '${name}'`, root));
    }
  } else {
    for (const [name, root] of Object.entries(opts.vaults)) {
      kept.push({ label: `vault '${name}' (your memory; includes .memory/backups/)`, path: root });
    }
  }
  if (!opts.purgeRepoConfig && fs.existsSync(t.repoConfigFile)) {
    kept.push({ label: 'config.local.yml (repo root; pass --purge-repo-config to remove)', path: t.repoConfigFile });
  }

  const hooks = unregisterClaudeHooks(opts.settingsPath);

  return { removed, kept, hooks, mcpServerJs: resolveMcpServerJs() };
}
