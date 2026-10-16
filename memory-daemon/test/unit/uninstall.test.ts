import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runUninstall, type UninstallTargets } from '../../src/cli/uninstall.js';

/**
 * `memory uninstall` removes the system footprint and unregisters the hooks,
 * but keeps the user's vault by default. Every path is an explicit temp path, so
 * the developer's real index, config, vault and settings are never touched.
 */

let tmp: string;
let targets: UninstallTargets;
let vaultRoot: string;
let settingsPath: string;

/** A settings.json holding one foreign hook plus our three (as init would register them). */
const SETTINGS = {
  permissions: { allow: ['Bash(git status)'] },
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node /x/dist/hooks/session-start.js' }] }],
    Stop: [
      { hooks: [{ type: 'command', command: 'node /home/me/my-formatter.js' }] },
      { hooks: [{ type: 'command', command: 'node /x/dist/hooks/turn-counter.js' }] },
    ],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'node /x/dist/hooks/session-end.js' }] }],
  },
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-uninstall-'));
  vaultRoot = path.join(tmp, 'vault');
  settingsPath = path.join(tmp, 'settings.json');
  targets = {
    indexDir: path.join(tmp, 'data', 'index'),
    tokenFile: path.join(tmp, 'data', 'daemon.token'),
    modelCache: path.join(tmp, 'data', 'models'),
    logsDir: path.join(tmp, 'data', 'logs'),
    configFile: path.join(tmp, 'config', 'config.yml'),
    repoConfigFile: path.join(tmp, 'repo', 'config.local.yml'),
  };
  // Materialize the whole footprint.
  fs.mkdirSync(path.join(targets.indexDir, 'gen-000001'), { recursive: true });
  fs.mkdirSync(targets.modelCache, { recursive: true });
  fs.mkdirSync(targets.logsDir, { recursive: true });
  fs.mkdirSync(path.dirname(targets.tokenFile), { recursive: true });
  fs.writeFileSync(targets.tokenFile, 'deadbeef', 'utf8');
  fs.mkdirSync(path.dirname(targets.configFile), { recursive: true });
  fs.writeFileSync(targets.configFile, 'vaults:\n  global: x\n', 'utf8');
  fs.mkdirSync(path.dirname(targets.repoConfigFile), { recursive: true });
  fs.writeFileSync(targets.repoConfigFile, 'vaults:\n  global: x\n', 'utf8');
  // The vault (kept by default).
  fs.mkdirSync(path.join(vaultRoot, '.memory', 'backups'), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, 'USER.md'), '# USER\n', 'utf8');
  fs.writeFileSync(settingsPath, JSON.stringify(SETTINGS, null, 2), 'utf8');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

describe('runUninstall (default: keep the vault)', () => {
  it('removes the system footprint, unregisters only our hooks, and keeps the vault', () => {
    const res = runUninstall({ targets, vaults: { global: vaultRoot }, settingsPath });

    // System footprint is gone.
    expect(fs.existsSync(targets.indexDir)).toBe(false);
    expect(fs.existsSync(targets.tokenFile)).toBe(false);
    expect(fs.existsSync(targets.modelCache)).toBe(false);
    expect(fs.existsSync(targets.logsDir)).toBe(false);
    expect(fs.existsSync(targets.configFile)).toBe(false);

    // The vault and its backups are KEPT, and the repo-root config is untouched.
    expect(fs.existsSync(path.join(vaultRoot, 'USER.md'))).toBe(true);
    expect(fs.existsSync(path.join(vaultRoot, '.memory', 'backups'))).toBe(true);
    expect(fs.existsSync(targets.repoConfigFile)).toBe(true);

    // Hooks: our three unregistered, the foreign formatter preserved.
    expect(res.hooks.action).toBe('updated');
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(after.hooks.SessionStart).toBeUndefined();
    expect(after.hooks.SessionEnd).toBeUndefined();
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.Stop[0].hooks[0].command).toBe('node /home/me/my-formatter.js');
    expect(after.permissions).toEqual(SETTINGS.permissions);

    // The report labels vault + repo config as kept, and names the MCP entry.
    expect(res.kept.some((k) => k.path === vaultRoot)).toBe(true);
    expect(res.kept.some((k) => k.path === targets.repoConfigFile)).toBe(true);
    expect(res.mcpServerJs).toContain('index.js');
  });
});

describe('runUninstall (--purge-vault / --purge-repo-config)', () => {
  it('deletes the vault when purgeVault is set', () => {
    const res = runUninstall({ targets, vaults: { global: vaultRoot }, settingsPath, purgeVault: true });
    expect(fs.existsSync(vaultRoot)).toBe(false);
    expect(res.removed.some((r) => r.path === vaultRoot && r.existed)).toBe(true);
    expect(res.kept.some((k) => k.path === vaultRoot)).toBe(false);
  });

  it('deletes the repo-root config only with purgeRepoConfig', () => {
    const res = runUninstall({ targets, vaults: { global: vaultRoot }, settingsPath, purgeRepoConfig: true });
    expect(fs.existsSync(targets.repoConfigFile)).toBe(false);
    expect(res.removed.some((r) => r.path === targets.repoConfigFile && r.existed)).toBe(true);
  });
});
