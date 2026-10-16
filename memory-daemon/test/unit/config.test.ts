import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveConfigSource, describeConfigOrigin, REPO_CONFIG } from '../../src/core/config.js';

/**
 * OpenRouter key hygiene (security finding #5), the safe egress default, and
 * the first-run vault guard.
 *
 * Every case is hermetic: it never reads a real config.local.yml or a
 * real OS config dir. The repo-root source is redirected with `configPath`,
 * and the OS-config-dir source is redirected with MEMORY_APPDATA_DIR to an
 * empty temp dir, so no real key can leak into a test. Vault sources are also
 * cleared so a MEMORY_VAULT_* var in the real shell cannot mask the guard.
 */

let savedEnv: NodeJS.ProcessEnv;
const tmpDirs: string[] = [];

/** Creates an existing temp directory to stand in for a vault root. */
function makeVaultDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-vault-'));
  tmpDirs.push(dir);
  return dir;
}

/** Writes a yaml config file with exactly `contents` and returns its path. */
function writeConfigRaw(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-config-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'config.local.yml');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

/**
 * Writes a config with a valid single-vault header (an existing temp dir as
 * the vault path) plus any `extra` yaml. Use for cases that need loadConfig to
 * get past the first-run guard. JSON.stringify quotes the Windows path safely
 * for yaml (a JSON string is a valid yaml double-quoted scalar).
 */
function writeConfig(extra = ''): string {
  const vault = makeVaultDir();
  const header = `vaults:\n  global: ${JSON.stringify(vault)}\ndefault_vault: global\n`;
  return writeConfigRaw(header + extra);
}

beforeEach(() => {
  savedEnv = { ...process.env };
  // No key sources leak in from the real environment.
  delete process.env['OPENROUTER_API_KEY'];
  delete process.env['OPENROUTER_MODEL'];
  delete process.env['MEMORY_CONFIG'];
  // Neutralize the repo-local candidate so a real config.local.yml can
  // never leak into a precedence test; each case sets it explicitly.
  delete process.env['MEMORY_REPO_CONFIG'];
  // No real-shell vault vars can mask or feed the first-run guard.
  for (const k of Object.keys(process.env)) {
    if (/^MEMORY_VAULT_/.test(k) || k === 'MEMORY_DEFAULT_VAULT') delete process.env[k];
  }
  // Point the OS-config-dir source (b) at an empty temp dir (no config.yml).
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-appdata-'));
  tmpDirs.push(appdata);
  process.env['MEMORY_APPDATA_DIR'] = appdata;
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('loadConfig — OpenRouter key resolution', () => {
  it('the OPENROUTER_API_KEY env var is used and overrides a file key', () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-or-test-env';
    const file = writeConfig('openrouter:\n  api_key: sk-or-test-file\n');
    const cfg = loadConfig({ configPath: file });
    expect(cfg.openrouter?.apiKey).toBe('sk-or-test-env');
  });

  it('a real key in the repo-root config file is used when no env var is set (an existing local setup keeps working)', () => {
    const file = writeConfig('openrouter:\n  api_key: sk-or-test-file\n  model: openai/gpt-oss-120b\n');
    const cfg = loadConfig({ configPath: file });
    expect(cfg.openrouter?.apiKey).toBe('sk-or-test-file');
    expect(cfg.openrouter?.model).toBe('openai/gpt-oss-120b');
  });

  it('with no env var and no key, openrouter is undefined (capture off, zero egress)', () => {
    const file = writeConfig();
    const cfg = loadConfig({ configPath: file });
    expect(cfg.openrouter).toBeUndefined();
  });

  it('the shipped placeholder REPLACE_WITH_YOUR_OPENROUTER_KEY is treated as no key (capture stays off)', () => {
    const file = writeConfig('openrouter:\n  api_key: REPLACE_WITH_YOUR_OPENROUTER_KEY\n');
    const cfg = loadConfig({ configPath: file });
    expect(cfg.openrouter).toBeUndefined();
  });

  it('the legacy placeholder COLE_A_CHAVE_AQUI is still treated as no key (old local configs)', () => {
    const file = writeConfig('openrouter:\n  api_key: COLE_A_CHAVE_AQUI\n');
    const cfg = loadConfig({ configPath: file });
    expect(cfg.openrouter).toBeUndefined();
  });

  it('any REPLACE_-prefixed value is treated as no key (an edited-but-still-placeholder line)', () => {
    const file = writeConfig('openrouter:\n  api_key: REPLACE_ME_WITH_A_KEY\n');
    const cfg = loadConfig({ configPath: file });
    expect(cfg.openrouter).toBeUndefined();
  });

  it('a realistic key string is treated as a key (capture can turn on)', () => {
    const file = writeConfig('openrouter:\n  api_key: sk-or-v1-0123456789abcdef\n');
    const cfg = loadConfig({ configPath: file });
    expect(cfg.openrouter?.apiKey).toBe('sk-or-v1-0123456789abcdef');
  });
});

describe('loadConfig — vaults and first-run guard', () => {
  it('loads the vaults from the config file when the default-vault path exists', () => {
    const vault = makeVaultDir();
    const file = writeConfigRaw(`vaults:\n  work: ${JSON.stringify(vault)}\ndefault_vault: work\n`);
    const cfg = loadConfig({ configPath: file });
    expect(cfg.vaults['work']).toBe(vault);
    expect(cfg.defaultVault).toBe('work');
  });

  it('throws a clear error when no vaults are configured anywhere (no silent empty result)', () => {
    const file = writeConfigRaw('openrouter:\n  api_key: sk-or-test-file\n');
    expect(() => loadConfig({ configPath: file })).toThrow(/No vault configured/);
  });

  it('throws a clear error when the default vault path does not exist on disk', () => {
    const missing = path.join(os.tmpdir(), 'mv-does-not-exist-' + Date.now());
    const file = writeConfigRaw(`vaults:\n  global: ${JSON.stringify(missing)}\ndefault_vault: global\n`);
    expect(() => loadConfig({ configPath: file })).toThrow(/does not exist/);
  });

  it('resolves REPO_CONFIG relative to the module, at the repo root', () => {
    // The config module and this test both sit three levels under the repo
    // root, so the same relative walk must land on the same file.
    const expected = fileURLToPath(new URL('../../../config.local.yml', import.meta.url));
    expect(REPO_CONFIG).toBe(expected);
    expect(path.basename(REPO_CONFIG)).toBe('config.local.yml');
  });
});

describe('resolveConfigSource — config precedence (finding 5)', () => {
  /** A repo-local candidate path that does NOT exist (isolates the OS-dir branch). */
  function missingRepoCandidate(): string {
    return path.join(os.tmpdir(), `mv-no-repo-${Date.now()}-${Math.random()}.yml`);
  }

  it('an explicit configPath wins and reports origin "explicit"', () => {
    const file = writeConfig();
    const src = resolveConfigSource({ configPath: file });
    expect(src.path).toBe(file);
    expect(src.origin).toBe('explicit');
    expect(src.exists).toBe(true);
  });

  it('MEMORY_CONFIG wins over a present repo-root config.local.yml', () => {
    const envFile = writeConfig();
    const repoFile = writeConfig(); // present too, but env must win
    process.env['MEMORY_CONFIG'] = envFile;
    process.env['MEMORY_REPO_CONFIG'] = repoFile;
    const src = resolveConfigSource();
    expect(src.path).toBe(envFile);
    expect(src.origin).toBe('env');
  });

  it('a present repo-root config.local.yml shadows the OS config dir', () => {
    const repoFile = writeConfig();
    process.env['MEMORY_REPO_CONFIG'] = repoFile;
    const src = resolveConfigSource();
    expect(src.path).toBe(repoFile);
    expect(src.origin).toBe('repo_local');
    expect(src.exists).toBe(true);
  });

  it('falls back to the OS config dir when nothing else is set', () => {
    process.env['MEMORY_REPO_CONFIG'] = missingRepoCandidate();
    const src = resolveConfigSource();
    expect(src.origin).toBe('os_config_dir');
    // The OS-dir file lives under MEMORY_APPDATA_DIR (an empty temp dir here).
    expect(src.path).toBe(path.join(process.env['MEMORY_APPDATA_DIR']!, 'config.yml'));
    expect(src.exists).toBe(false);
  });

  it('loadConfig actually reads the shadowing repo-local file (proves the footgun is real)', () => {
    const shadowVault = makeVaultDir();
    const repoFile = writeConfigRaw(`vaults:\n  shadow: ${JSON.stringify(shadowVault)}\ndefault_vault: shadow\n`);
    process.env['MEMORY_REPO_CONFIG'] = repoFile;
    // No explicit path and no MEMORY_CONFIG: loadConfig must read the repo-local file.
    const cfg = loadConfig();
    expect(cfg.defaultVault).toBe('shadow');
    expect(cfg.vaults['shadow']).toBe(shadowVault);
  });

  it('describeConfigOrigin gives a plain-English label for every origin', () => {
    expect(describeConfigOrigin('repo_local')).toMatch(/config\.local\.yml/);
    expect(describeConfigOrigin('os_config_dir')).toMatch(/OS config/i);
    expect(describeConfigOrigin('env')).toMatch(/MEMORY_CONFIG/);
    expect(describeConfigOrigin('explicit')).toMatch(/explicit/i);
  });
});

describe('triage backend resolution', () => {
  it('a triage block choosing claude-cli turns capture on with no key at all', () => {
    const file = writeConfig('triage:\n  backend: claude-cli\n');
    const cfg = loadConfig({ configPath: file });
    expect(cfg.triage).toEqual({ backend: 'claude-cli', model: 'haiku', command: undefined });
    expect(cfg.openrouter).toBeUndefined();
  });

  it('claude-cli honours an explicit model and command, and wins over a present key', () => {
    const file = writeConfig(
      'triage:\n  backend: claude-cli\n  model: claude-haiku-4-5\n  command: C:/tools/claude.exe\n'
      + 'openrouter:\n  api_key: sk-or-test-file\n',
    );
    const cfg = loadConfig({ configPath: file });
    expect(cfg.triage?.backend).toBe('claude-cli');
    expect(cfg.triage?.model).toBe('claude-haiku-4-5');
    expect(cfg.triage?.command).toBe('C:/tools/claude.exe');
    // The key stays resolved: it is the documented fallback backend.
    expect(cfg.openrouter?.apiKey).toBe('sk-or-test-file');
  });

  it('with no triage block, a real key selects the openrouter backend', () => {
    const file = writeConfig('openrouter:\n  api_key: sk-or-test-file\n  model: openai/gpt-oss-120b\n');
    const cfg = loadConfig({ configPath: file });
    expect(cfg.triage).toEqual({ backend: 'openrouter', model: 'openai/gpt-oss-120b' });
  });

  it('no block and no key means no triage: the safe zero-egress default', () => {
    const file = writeConfig();
    const cfg = loadConfig({ configPath: file });
    expect(cfg.triage).toBeUndefined();
  });
});
