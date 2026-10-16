import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { initMemory, cmdInit, seedFacts, ConfigExistsError, resolveMcpServerJs, buildMcpConfig } from '../../src/cli/init.js';
import { resolveHookScripts, hookCommand } from '../../src/cli/hooks-register.js';
import { runGet } from '../../src/daemon/write-pipeline.js';
import type { MemoryConfig } from '../../src/core/config.js';

/**
 * `memory init`. Every case is hermetic: MEMORY_CONFIG_DIR and MEMORY_DATA_DIR
 * are redirected to temp dirs and the vault is a temp dir, so init never
 * touches the developer's real config, index, or vault. No model download, no
 * daemon, no network.
 */

let tmp: string;
let savedEnv: NodeJS.ProcessEnv;

/** Reads and parses the config.yml init wrote. */
function readConfig(configPath: string): Record<string, unknown> {
  return yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  savedEnv = { ...process.env };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-init-'));
  // Redirect the config dir and the data/index dir to temp: nothing real is touched.
  process.env['MEMORY_CONFIG_DIR'] = path.join(tmp, 'config');
  process.env['MEMORY_DATA_DIR'] = path.join(tmp, 'data');
  // Neutralize the config-source resolution so a real config.local.yml (or
  // a MEMORY_CONFIG in the shell) cannot make init print a shadow warning here.
  // Cases that assert the warning opt in by setting MEMORY_REPO_CONFIG to a real file.
  delete process.env['MEMORY_CONFIG'];
  process.env['MEMORY_REPO_CONFIG'] = path.join(tmp, 'no-repo-config.yml'); // does not exist
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

describe('initMemory', () => {
  it('creates the vault with seeded USER.md and MEMORY.md carrying the <!-- auto --> markers', () => {
    const vault = path.join(tmp, 'vault');
    const res = initMemory({ vault });

    expect(res.seeded.sort()).toEqual(['MEMORY.md', 'USER.md']);
    const user = fs.readFileSync(path.join(vault, 'USER.md'), 'utf8');
    const memory = fs.readFileSync(path.join(vault, 'MEMORY.md'), 'utf8');
    // Headings plus at least one agent-writable section per file.
    expect(user).toContain('# USER');
    expect(user).toContain('<!-- auto -->');
    expect(memory).toContain('# MEMORY');
    expect(memory).toContain('<!-- auto -->');
  });

  it('writes config.yml with the vault, default_vault, and embeddings enabled; no openrouter key', () => {
    const vault = path.join(tmp, 'vault');
    const res = initMemory({ vault });

    expect(res.configPath).toBe(path.join(tmp, 'config', 'config.yml'));
    const cfg = readConfig(res.configPath) as {
      vaults: Record<string, string>;
      default_vault: string;
      embeddings: { enabled: boolean };
      openrouter?: unknown;
    };
    expect(cfg.default_vault).toBe('global');
    expect(cfg.vaults['global']).toBe(path.resolve(vault));
    expect(cfg.embeddings.enabled).toBe(true);
    // Capture stays OFF: no secret is written.
    expect(cfg.openrouter).toBeUndefined();
  });

  it('honors a custom --name for the config vault', () => {
    const res = initMemory({ vault: path.join(tmp, 'vault'), name: 'work' });
    const cfg = readConfig(res.configPath) as { vaults: Record<string, string>; default_vault: string };
    expect(cfg.default_vault).toBe('work');
    expect(Object.keys(cfg.vaults)).toEqual(['work']);
  });

  it('ensures the index dir exists so the first reconcile is not blocked', () => {
    const res = initMemory({ vault: path.join(tmp, 'vault') });
    expect(fs.existsSync(res.indexDir)).toBe(true);
  });

  it('ensures the runtime dir exists so the first daemon socket bind never fails on a missing parent', () => {
    // Pin the runtime dir to a temp path that does not exist yet; on macOS/Linux
    // the daemon binds its Unix socket here, so init must create it up front.
    const runtime = path.join(tmp, 'runtime', 'nested');
    process.env['MEMORY_RUNTIME_DIR'] = runtime;
    expect(fs.existsSync(runtime)).toBe(false);

    const res = initMemory({ vault: path.join(tmp, 'vault') });

    expect(res.runtimeDir).toBe(runtime);
    expect(fs.existsSync(runtime)).toBe(true);
  });

  it('refuses to overwrite an existing config without --force, then proceeds with --force', () => {
    const vault = path.join(tmp, 'vault');
    initMemory({ vault });

    // Second run without --force: refused, and the message points at the file.
    expect(() => initMemory({ vault })).toThrow(ConfigExistsError);
    try {
      initMemory({ vault });
    } catch (e) {
      expect((e as ConfigExistsError).message).toContain('config.yml');
      expect((e as ConfigExistsError).message).toContain('--force');
    }

    // With --force it proceeds and rewrites the config.
    const res = initMemory({ vault, name: 'work', force: true });
    expect(res.overwroteConfig).toBe(true);
    const cfg = readConfig(res.configPath) as { default_vault: string };
    expect(cfg.default_vault).toBe('work');
  });

  // --force used to write a vaults map with ONE entry, so every vault added with
  // `memory vault add` was dropped and the person found out months later, when
  // searches came back empty.
  it('--force keeps the vaults already listed in the config it replaces', () => {
    const vault = path.join(tmp, 'vault');
    const first = initMemory({ vault });

    // A second vault, added the way `memory vault add` adds one.
    const clientPath = path.join(tmp, 'client-acme');
    fs.mkdirSync(clientPath, { recursive: true });
    const before = yaml.load(fs.readFileSync(first.configPath, 'utf8')) as Record<string, unknown>;
    (before['vaults'] as Record<string, string>)['acme'] = clientPath;
    fs.writeFileSync(first.configPath, yaml.dump(before), 'utf8');

    const res = initMemory({ vault, name: 'global', force: true });

    const cfg = readConfig(res.configPath) as { vaults: Record<string, string>; default_vault: string };
    expect(Object.keys(cfg.vaults).sort()).toEqual(['acme', 'global']);
    expect(cfg.vaults['acme']).toBe(clientPath);
    // The vault named on THIS run still wins, and it is still the default.
    expect(cfg.vaults['global']).toBe(path.resolve(vault));
    expect(cfg.default_vault).toBe('global');
    // Keeping them is reported, not silent.
    expect(res.keptVaults).toEqual(['acme']);
    expect(res.oldConfigUnreadable).toBe(false);
  });

  it('--force says so when the config it replaces could not be read, instead of dropping vaults silently', () => {
    const vault = path.join(tmp, 'vault');
    const first = initMemory({ vault });
    fs.writeFileSync(first.configPath, 'vaults: [unclosed\n', 'utf8');

    const res = initMemory({ vault, force: true });

    expect(res.oldConfigUnreadable).toBe(true);
    expect(res.keptVaults).toEqual([]);
    // The new config is still valid and usable.
    const cfg = readConfig(res.configPath) as { vaults: Record<string, string> };
    expect(cfg.vaults['global']).toBe(path.resolve(vault));
  });

  it('does not overwrite existing seed files in a vault that already has them', () => {
    const vault = path.join(tmp, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    const mine = '# USER\n\nmy own content, keep me\n';
    fs.writeFileSync(path.join(vault, 'USER.md'), mine, 'utf8');

    const res = initMemory({ vault, force: true });

    expect(res.keptExisting).toContain('USER.md');
    expect(res.seeded).toContain('MEMORY.md');
    // The pre-existing file is untouched.
    expect(fs.readFileSync(path.join(vault, 'USER.md'), 'utf8')).toBe(mine);
  });

  it('resolves the MCP server entry to an absolute dist/mcp/index.js path', () => {
    const p = resolveMcpServerJs();
    expect(path.isAbsolute(p)).toBe(true);
    // Always the built entry, even when the CLI runs from the src layout.
    expect(p.endsWith(path.join('dist', 'mcp', 'index.js'))).toBe(true);
  });
});

describe('cmdInit', () => {
  it('prints an MCP snippet containing the absolute path to dist/mcp/index.js', async () => {
    const lines: string[] = [];
    await cmdInit(['--vault', path.join(tmp, 'vault'), '--no-hooks'], { log: (l) => lines.push(l) });

    const out = lines.join('\n');
    const serverJs = resolveMcpServerJs();
    // The path always ends at the built MCP entry.
    expect(serverJs.endsWith(path.join('dist', 'mcp', 'index.js'))).toBe(true);
    // The full JSON snippet is printed verbatim; it embeds the absolute path
    // (JSON-escaped, so a Windows path's backslashes are doubled -- correct for
    // an MCP config file).
    expect(out).toContain(buildMcpConfig(serverJs));
    expect(out).toContain(JSON.stringify(serverJs));
    // The snippet is the standard MCP registration shape.
    expect(out).toContain('"mcpServers"');
    expect(out).toContain('"command": "node"');
    // And it names the guide plus how to enable capture.
    expect(out).toContain('docs/agent-guide.md');
    expect(out).toContain('Capture is OFF');
    // It points a non-Claude agent at the pasteable system-prompt block.
    expect(out).toContain('system prompt for');
    expect(out).toContain('docs/agent-guide.md');
  });
});

describe('cmdInit — active config reporting (finding 5)', () => {
  it('--vault targets the given path: the written config points at it and the path is printed', async () => {
    const vault = path.join(tmp, 'chosen-vault');
    const lines: string[] = [];
    await cmdInit(['--vault', vault, '--no-hooks'], { log: (l) => lines.push(l) });

    // The config init wrote points at exactly the requested vault.
    const cfg = readConfig(path.join(tmp, 'config', 'config.yml')) as { vaults: Record<string, string> };
    expect(cfg.vaults['global']).toBe(path.resolve(vault));
    // And the chosen vault path is shown to the user.
    expect(lines.join('\n')).toContain(path.resolve(vault));
  });

  it('prints "config in use" (no warning) when the written config is the one that will be read', async () => {
    const lines: string[] = [];
    // MEMORY_REPO_CONFIG is a non-existent path (beforeEach), so the OS-dir file
    // init writes is the file that wins.
    await cmdInit(['--vault', path.join(tmp, 'vault'), '--no-hooks'], { log: (l) => lines.push(l) });

    const out = lines.join('\n');
    expect(out).toContain('config in use:');
    expect(out).toContain(path.join(tmp, 'config', 'config.yml'));
    expect(out).not.toContain('WARNING');
  });

  it('WARNS loudly when a repo-root config.local.yml will shadow the config it just wrote', async () => {
    // A present repo-local candidate wins over the OS-dir file init writes.
    const repoFile = path.join(tmp, 'config.local.yml');
    fs.writeFileSync(repoFile, 'vaults:\n  global: /somewhere\ndefault_vault: global\n', 'utf8');
    process.env['MEMORY_REPO_CONFIG'] = repoFile;

    const lines: string[] = [];
    await cmdInit(['--vault', path.join(tmp, 'vault'), '--no-hooks'], { log: (l) => lines.push(l) });

    const out = lines.join('\n');
    expect(out).toContain('WARNING');
    // It names both the shadowing file (wins) and the shadowed file init wrote.
    expect(out).toContain(repoFile);
    expect(out).toContain(path.join(tmp, 'config', 'config.yml'));
    expect(out).toContain('config.local.yml');
  });
});

/** A config that reads the temp vault back through the write pipeline's runGet. */
function tmpConfig(vault: string): MemoryConfig {
  return { vaults: { global: vault }, defaultVault: 'global', embeddings: { enabled: false, model: 'x' } };
}

describe('seedFacts', () => {
  it('writes first facts into USER.md/MEMORY.md with human_direct provenance, readable via memory_get', async () => {
    const vault = path.join(tmp, 'vault');
    initMemory({ vault });

    const written = await seedFacts(vault, [
      { file: 'user', section: 'Profile', text: 'Alice, staff engineer at Acme' },
      { file: 'memory', section: 'Conventions', text: 'Commit messages in English, no AI lines' },
      { file: 'user', section: 'Preferences', text: '' }, // empty -> skipped
    ]);

    expect(written.map((w) => w.path_hint)).toEqual(['global:USER.md', 'global:MEMORY.md']);

    // On disk, each bullet carries the same src:human marker `memory add` writes.
    expect(fs.readFileSync(path.join(vault, 'USER.md'), 'utf8')).toMatch(/Alice, staff engineer at Acme.*src:human/);
    expect(fs.readFileSync(path.join(vault, 'MEMORY.md'), 'utf8')).toMatch(/Commit messages in English.*src:human/);

    // And they read back through the same runGet memory_get uses.
    const config = tmpConfig(vault);
    const user = runGet(config, { file: 'user', section: 'Profile', vault: 'global' }) as any;
    expect(user.sections[0].entries.some((e: any) => e.text.includes('staff engineer at Acme'))).toBe(true);
    const memory = runGet(config, { file: 'memory', section: 'Conventions', vault: 'global' }) as any;
    expect(memory.sections[0].entries.some((e: any) => e.text.includes('Commit messages in English'))).toBe(true);
  });

  it('refuses a fact for a section that does not exist', async () => {
    const vault = path.join(tmp, 'vault');
    initMemory({ vault });
    await expect(seedFacts(vault, [{ file: 'user', section: 'Nope', text: 'x' }]))
      .rejects.toThrow(/section 'Nope'/);
  });
});

describe('cmdInit hook registration', () => {
  const scripts = resolveHookScripts();

  it('--hooks registers the three hooks into the temp settings.json, merging and writing a .bak', async () => {
    const settingsPath = path.join(tmp, 'settings.json');
    const existing = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /x/foreign.js' }] }] } };
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), 'utf8');

    const lines: string[] = [];
    await cmdInit(
      ['--vault', path.join(tmp, 'vault'), '--non-interactive', '--hooks', '--settings', settingsPath],
      { log: (l) => lines.push(l) },
    );

    // A .bak of the original was written.
    expect(fs.existsSync(settingsPath + '.bak')).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsPath + '.bak', 'utf8'))).toEqual(existing);

    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe(hookCommand(scripts.sessionStart));
    expect(s.hooks.SessionEnd[0].hooks[0].command).toBe(hookCommand(scripts.sessionEnd));
    // Foreign Stop hook preserved, ours added next to it.
    const stop = s.hooks.Stop.map((g: any) => g.hooks[0].command);
    expect(stop).toContain('node /x/foreign.js');
    expect(stop.some((c: string) => c.includes('turn-counter.js'))).toBe(true);
    // And init says what it did.
    expect(lines.join('\n')).toMatch(/Claude Code hooks merged/);
  });

  it('--no-hooks does not touch the settings file and prints the manual JSON block', async () => {
    const settingsPath = path.join(tmp, 'settings.json');
    const original = JSON.stringify({ hooks: { Stop: [] }, other: 1 }, null, 2);
    fs.writeFileSync(settingsPath, original, 'utf8');

    const lines: string[] = [];
    await cmdInit(
      ['--vault', path.join(tmp, 'vault'), '--non-interactive', '--no-hooks', '--settings', settingsPath],
      { log: (l) => lines.push(l) },
    );

    // Settings byte-unchanged, no backup written.
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(original);
    expect(fs.existsSync(settingsPath + '.bak')).toBe(false);
    // The pasteable block is printed instead (JSON-escaped, so assert on the
    // script basenames and the event keys rather than the raw path string).
    const out = lines.join('\n');
    expect(out).toContain('"SessionStart"');
    expect(out).toContain('"Stop"');
    expect(out).toContain('"SessionEnd"');
    expect(out).toContain('session-start.js');
    expect(out).toContain('turn-counter.js');
    expect(out).toContain('paste this into');
  });

  it('interactive: seeds the answers and registers hooks through the injected prompts', async () => {
    const settingsPath = path.join(tmp, 'settings.json'); // does not exist yet
    const vault = path.join(tmp, 'vault');
    const answers = ['Alice, staff engineer at Acme', 'Commit in English only', 'Short answers'];
    const lines: string[] = [];

    await cmdInit(
      ['--vault', vault, '--hooks', '--settings', settingsPath],
      {
        log: (l) => lines.push(l),
        interactive: true,
        ask: async () => answers.shift() ?? '',
        confirm: async () => true, // "create the missing settings file?" -> yes
      },
    );

    // The three answers landed as real, human-tagged memory.
    expect(fs.readFileSync(path.join(vault, 'USER.md'), 'utf8')).toMatch(/Alice, staff engineer at Acme.*src:human/);
    expect(fs.readFileSync(path.join(vault, 'MEMORY.md'), 'utf8')).toMatch(/Commit in English only.*src:human/);
    // The hooks file was created with all three events.
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(Object.keys(s.hooks).sort()).toEqual(['SessionEnd', 'SessionStart', 'Stop']);
    expect(lines.join('\n')).toMatch(/seeded 3 fact\(s\)/);
  });
});
