import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import pino from 'pino';
import {
  cmdVault, addVaultToConfigText, missingCuratedFiles, VaultCommandError, type VaultDeps,
} from '../../src/cli/vault.js';
import { dispatch, resolveSearchVault } from '../../src/cli/memory.js';
import { readableVaults } from '../../src/core/vault-scope.js';
import { runGet, runMutate, ToolError } from '../../src/daemon/write-pipeline.js';
import { openIndexDb } from '../../src/index/db.js';
import { makeTmpIndexDir } from '../helpers/tmp-vault.js';
import type { ConfigSource, MemoryConfig } from '../../src/core/config.js';

/**
 * `memory vault add` exists because the only other way to register a vault was
 * `memory init --force`, which REPLACES the whole vaults map and would silently
 * drop a client vault. So the load-bearing property here is: it merges, it keeps
 * every other byte of the config file, and it refuses anything it cannot do
 * safely.
 */

const tmpDirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Writes a config file with exactly this text and returns it as a ConfigSource. */
function makeConfig(contents: string): ConfigSource {
  const file = path.join(makeDir('mv-cfgdir-'), 'config.local.yml');
  fs.writeFileSync(file, contents, 'utf8');
  return { path: file, origin: 'repo_local', exists: true };
}

/** Deps that capture output and edit exactly the given config file. */
function makeDeps(source: ConfigSource): VaultDeps & { lines: string[] } {
  const lines: string[] = [];
  return { lines, out: (line) => lines.push(line), source };
}

/** A minimal config file listing these vaults, for the commands that READ the config. */
function writeVaultConfig(file: string, vaults: Record<string, string>, defaultVault = 'global'): void {
  const entries = Object.entries(vaults).map(([name, root]) => `  ${name}: ${JSON.stringify(root)}`);
  fs.writeFileSync(file, `vaults:\n${entries.join('\n')}\ndefault_vault: ${defaultVault}\n`, 'utf8');
}

const EXISTING = `# my config, edited by hand
vaults:
  global: "C:\\\\vaults\\\\global"
  clientA: "C:\\\\vaults\\\\clientA"
default_vault: global
openrouter:
  api_key: sk-or-v1-existing-key
`;

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('memory vault add', () => {
  let newVault: string;

  beforeEach(() => {
    newVault = makeDir('mv-newvault-');
  });

  it('merges: the vaults already configured survive', async () => {
    const source = makeConfig(EXISTING);
    await cmdVault(['add', 'clientB', newVault], makeDeps(source));

    const parsed = yaml.load(fs.readFileSync(source.path, 'utf8')) as { vaults: Record<string, string>; default_vault: string };
    expect(Object.keys(parsed.vaults).sort()).toEqual(['clientA', 'clientB', 'global']);
    expect(parsed.vaults['clientB']).toBe(path.resolve(newVault));
    expect(parsed.vaults['clientA']).toBe('C:\\vaults\\clientA');
    expect(parsed.default_vault).toBe('global');
  });

  it('keeps comments and the rest of the file untouched (it never rewrites the yaml)', async () => {
    const source = makeConfig(EXISTING);
    await cmdVault(['add', 'clientB', newVault], makeDeps(source));
    const after = fs.readFileSync(source.path, 'utf8');
    expect(after).toContain('# my config, edited by hand');
    // The key line matters most: a yaml round-trip could reformat or drop it.
    expect(after).toContain('api_key: sk-or-v1-existing-key');
  });

  it('says which config file it changed and what still has to happen', async () => {
    const source = makeConfig(EXISTING);
    const deps = makeDeps(source);
    await cmdVault(['add', 'clientB', newVault], deps);
    const out = deps.lines.join('\n');
    expect(out).toContain(source.path);
    expect(out).toContain('memory daemon stop');
    expect(out).toContain('memory index --vault clientB');
    expect(out).toContain('.memory.yml');
    expect(out).toContain('vault: clientB');
    // The new vault is private by default, and the one line that opens it up is
    // spelled out, because nothing else in the product hints at the key name.
    expect(out).toContain('share_global: true');
    expect(out).toMatch(/starts with empty\s*\n?\s*memory/);
  });

  it('refuses a duplicate name instead of overwriting the path', async () => {
    const source = makeConfig(EXISTING);
    await expect(cmdVault(['add', 'clientA', newVault], makeDeps(source))).rejects.toThrow(VaultCommandError);
    await expect(cmdVault(['add', 'clientA', newVault], makeDeps(source))).rejects.toThrow(/already exists/);
    // Nothing was written.
    expect(fs.readFileSync(source.path, 'utf8')).toBe(EXISTING);
  });

  it('refuses a folder that does not exist', async () => {
    const source = makeConfig(EXISTING);
    const missing = path.join(os.tmpdir(), `mv-missing-${Date.now()}`);
    await expect(cmdVault(['add', 'clientB', missing], makeDeps(source))).rejects.toThrow(/does not exist/);
    expect(fs.readFileSync(source.path, 'utf8')).toBe(EXISTING);
  });

  it('refuses a path that is a file, not a folder', async () => {
    const source = makeConfig(EXISTING);
    const file = path.join(makeDir('mv-file-'), 'notes.md');
    fs.writeFileSync(file, 'x', 'utf8');
    await expect(cmdVault(['add', 'clientB', file], makeDeps(source))).rejects.toThrow(/not a folder/);
  });

  it('refuses an unsafe name and the reserved word "all"', async () => {
    const source = makeConfig(EXISTING);
    await expect(cmdVault(['add', 'client B', newVault], makeDeps(source))).rejects.toThrow(/only letters, digits/);
    await expect(cmdVault(['add', '../escape', newVault], makeDeps(source))).rejects.toThrow(/only letters, digits/);
    await expect(cmdVault(['add', 'all', newVault], makeDeps(source))).rejects.toThrow(/reserved/);
  });

  it('refuses when there is no config file yet, and points at memory init', async () => {
    const source: ConfigSource = { path: path.join(makeDir('mv-none-'), 'config.yml'), origin: 'os_config_dir', exists: false };
    await expect(cmdVault(['add', 'clientB', newVault], makeDeps(source))).rejects.toThrow(/memory init/);
  });

  it('needs both a name and a path', async () => {
    const source = makeConfig(EXISTING);
    await expect(cmdVault(['add'], makeDeps(source))).rejects.toThrow(/usage/);
    await expect(cmdVault(['add', 'clientB'], makeDeps(source))).rejects.toThrow(/usage/);
  });

  // Registering the vault used to be all this command did, so the very first
  // project write answered FILE_NOT_FOUND and the README carried a manual step.
  // Every vault is self-contained now, so all THREE curated files are seeded:
  // a repo reading only its own vault has no other USER.md or MEMORY.md to use.
  it('seeds USER.md, MEMORY.md and PROJECT.md with <!-- auto --> sections, and the first project write then succeeds', async () => {
    const source = makeConfig(EXISTING);
    const deps = makeDeps(source);
    await cmdVault(['add', 'clientB', newVault], deps);

    const seedPath = path.join(newVault, 'PROJECT.md');
    const seeded = fs.readFileSync(seedPath, 'utf8');
    expect(seeded).toContain('# PROJECT');
    expect(seeded).toContain('## Decisions <!-- auto -->');
    expect(deps.lines.join('\n')).toContain('created');

    const userSeed = fs.readFileSync(path.join(newVault, 'USER.md'), 'utf8');
    expect(userSeed).toContain('# USER');
    expect(userSeed).toContain('## Preferences <!-- auto -->');
    const memorySeed = fs.readFileSync(path.join(newVault, 'MEMORY.md'), 'utf8');
    expect(memorySeed).toContain('# MEMORY');
    expect(memorySeed).toContain('## Decisions <!-- auto -->');

    const index = makeTmpIndexDir();
    const db = openIndexDb({ rootDir: index.root });
    try {
      const config: MemoryConfig = {
        vaults: { global: makeDir('mv-global-'), clientB: newVault },
        defaultVault: 'clientB',
        embeddings: { enabled: false, model: 'x' },
      };
      const writeDeps = { db, config, log: pino({ level: 'silent' }), indexerCtxFor: (): undefined => undefined };
      const before = runGet(config, { file: 'project', vault: 'clientB' }) as {
        hash: { sections: Record<string, string> };
      };
      const res = await runMutate(writeDeps, {
        file: 'project',
        vault: 'clientB',
        expect: { sectionHash: before.hash.sections['Decisions'] },
        ops: [{ op: 'add', section: 'Decisions', text: 'the first decision of this project' }],
      });
      expect(res['path_hint']).toBe('clientB:PROJECT.md');
      expect(fs.readFileSync(seedPath, 'utf8')).toContain('the first decision of this project');
    } finally {
      db.close();
      index.cleanup();
    }
  });

  it('never overwrites a curated file the folder already had', async () => {
    // Registering a folder that is already an Obsidian vault is a normal case,
    // so none of the three seeds may replace what is there.
    const mine: Record<string, string> = {
      'USER.md': '# USER\n\nmy own profile, keep me\n',
      'MEMORY.md': '# MEMORY\n\nmy own memory, keep me\n',
      'PROJECT.md': '# PROJECT\n\nmy own notes, keep me\n',
    };
    for (const [name, body] of Object.entries(mine)) {
      fs.writeFileSync(path.join(newVault, name), body, 'utf8');
    }

    const source = makeConfig(EXISTING);
    const deps = makeDeps(source);
    await cmdVault(['add', 'clientB', newVault], deps);

    for (const [name, body] of Object.entries(mine)) {
      expect(fs.readFileSync(path.join(newVault, name), 'utf8')).toBe(body);
    }
    expect(deps.lines.join('\n')).toContain('kept the USER.md, MEMORY.md, PROJECT.md already in that folder');
  });

  it('seeds only the curated files the folder is missing', async () => {
    const mine = '# PROJECT\n\nmy own notes, keep me\n';
    fs.writeFileSync(path.join(newVault, 'PROJECT.md'), mine, 'utf8');

    const source = makeConfig(EXISTING);
    const deps = makeDeps(source);
    await cmdVault(['add', 'clientB', newVault], deps);

    expect(fs.readFileSync(path.join(newVault, 'PROJECT.md'), 'utf8')).toBe(mine);
    expect(fs.existsSync(path.join(newVault, 'USER.md'))).toBe(true);
    expect(fs.existsSync(path.join(newVault, 'MEMORY.md'))).toBe(true);
    const out = deps.lines.join('\n');
    expect(out).toContain('created USER.md, MEMORY.md in that folder');
    expect(out).toContain('kept the PROJECT.md already in that folder');
  });
});

/**
 * `memory vault seed` is the repair verb. `memory vault add` seeds the curated
 * files, but every vault registered BEFORE that change has none of them, and its
 * first write answers FILE_NOT_FOUND. So the load-bearing properties are: it
 * creates what is missing, it never touches what is there, and it refuses any
 * target it cannot be sure about.
 */
describe('memory vault seed', () => {
  let savedEnv: NodeJS.ProcessEnv;
  let globalDir: string;
  let clientDir: string;
  let configFile: string;

  /** Deps for a folder with no `.memory.yml`, so no marker changes the vault. */
  function seedDeps(): VaultDeps & { lines: string[] } {
    const lines: string[] = [];
    return { lines, out: (line) => lines.push(line), cwd: makeDir('mv-seed-cwd-') };
  }

  beforeEach(() => {
    savedEnv = { ...process.env };
    // No real config, and no MEMORY_VAULT_* from the developer's shell.
    delete process.env['MEMORY_REPO_CONFIG'];
    for (const k of Object.keys(process.env)) {
      if (/^MEMORY_VAULT_/.test(k) || k === 'MEMORY_DEFAULT_VAULT') delete process.env[k];
    }
    // loadConfig also reads the OS config dir (for the OpenRouter key). Point it
    // at an empty temp dir so this test never opens a real file on the machine.
    process.env['MEMORY_CONFIG_DIR'] = makeDir('mv-seed-osconf-');
    globalDir = makeDir('mv-seed-global-');
    clientDir = makeDir('mv-seed-client-');
    configFile = path.join(makeDir('mv-seed-cfg-'), 'config.local.yml');
    writeVaultConfig(configFile, { global: globalDir, clientA: clientDir });
    process.env['MEMORY_CONFIG'] = configFile;
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  });

  it('creates the three curated files in a registered vault that has none, and a write then succeeds', async () => {
    const deps = seedDeps();
    await cmdVault(['seed', 'clientA'], deps);

    const userSeed = fs.readFileSync(path.join(clientDir, 'USER.md'), 'utf8');
    expect(userSeed).toContain('# USER');
    expect(userSeed).toContain('## Preferences <!-- auto -->');
    const memorySeed = fs.readFileSync(path.join(clientDir, 'MEMORY.md'), 'utf8');
    expect(memorySeed).toContain('# MEMORY');
    expect(memorySeed).toContain('## Decisions <!-- auto -->');
    const projectSeed = fs.readFileSync(path.join(clientDir, 'PROJECT.md'), 'utf8');
    expect(projectSeed).toContain('# PROJECT');
    expect(projectSeed).toContain('## Decisions <!-- auto -->');

    const out = deps.lines.join('\n');
    expect(out).toContain(clientDir);
    expect(out).toMatch(/USER\.md\s+created/);
    expect(out).toMatch(/MEMORY\.md\s+created/);
    expect(out).toMatch(/PROJECT\.md\s+created/);
    expect(out).toContain('memory index --vault clientA');

    // The reported failure was `memory add memory ...` from that repo, so the
    // proof is the same write going through the real pipeline.
    const index = makeTmpIndexDir();
    const db = openIndexDb({ rootDir: index.root });
    try {
      const config: MemoryConfig = {
        vaults: { global: globalDir, clientA: clientDir },
        defaultVault: 'clientA',
        embeddings: { enabled: false, model: 'x' },
      };
      const writeDeps = { db, config, log: pino({ level: 'silent' }), indexerCtxFor: (): undefined => undefined };
      const before = runGet(config, { file: 'memory', vault: 'clientA' }) as {
        hash: { sections: Record<string, string> };
      };
      const res = await runMutate(writeDeps, {
        file: 'memory',
        vault: 'clientA',
        expect: { sectionHash: before.hash.sections['Decisions'] },
        ops: [{ op: 'add', section: 'Decisions', text: 'the first decision after seeding' }],
      });
      expect(res['path_hint']).toBe('clientA:MEMORY.md');
      expect(fs.readFileSync(path.join(clientDir, 'MEMORY.md'), 'utf8')).toContain('the first decision after seeding');
    } finally {
      db.close();
      index.cleanup();
    }
  });

  it('never overwrites a curated file the vault already has, and says it was kept', async () => {
    const mine = '# MEMORY\n\nmy own memory, keep me\n';
    fs.writeFileSync(path.join(clientDir, 'MEMORY.md'), mine, 'utf8');

    const deps = seedDeps();
    await cmdVault(['seed', 'clientA'], deps);

    expect(fs.readFileSync(path.join(clientDir, 'MEMORY.md'), 'utf8')).toBe(mine);
    const out = deps.lines.join('\n');
    expect(out).toMatch(/MEMORY\.md\s+already there, kept/);
    expect(out).toMatch(/USER\.md\s+created/);
    expect(out).toMatch(/PROJECT\.md\s+created/);
  });

  it('is safe to run twice: the second run creates nothing and says so', async () => {
    await cmdVault(['seed', 'clientA'], seedDeps());
    const first = fs.readFileSync(path.join(clientDir, 'USER.md'), 'utf8');

    const deps = seedDeps();
    await cmdVault(['seed', 'clientA'], deps);
    expect(fs.readFileSync(path.join(clientDir, 'USER.md'), 'utf8')).toBe(first);
    expect(deps.lines.join('\n')).toContain('Nothing was missing');
  });

  it('refuses a vault name that is not in the config, and lists the ones that are', async () => {
    await expect(cmdVault(['seed', 'clientZ'], seedDeps())).rejects.toThrow(VaultCommandError);
    await expect(cmdVault(['seed', 'clientZ'], seedDeps())).rejects.toThrow(/no vault named 'clientZ'/);
    await expect(cmdVault(['seed', 'clientZ'], seedDeps())).rejects.toThrow(/global, clientA/);
    // Nothing was created anywhere.
    expect(fs.readdirSync(clientDir)).toEqual([]);
  });

  it('refuses a vault whose folder is not on disk, instead of creating it', async () => {
    const gone = path.join(os.tmpdir(), `mv-seed-gone-${Date.now()}`);
    // Not the default vault: loadConfig refuses a missing DEFAULT vault earlier,
    // and this test is about the seed command's own check.
    writeVaultConfig(configFile, { global: globalDir, clientA: gone });

    await expect(cmdVault(['seed', 'clientA'], seedDeps())).rejects.toThrow(/does not exist/);
    expect(fs.existsSync(gone)).toBe(false);
  });

  it('needs a vault name', async () => {
    await expect(cmdVault(['seed'], seedDeps())).rejects.toThrow(/usage: memory vault seed/);
  });

  // loadConfig's first-run guard fires on the DEFAULT vault, which is not the
  // vault the person named. It throws a plain Error, and the CLI used to print it
  // as a stack trace. This runs the REAL dispatch, because the exit code and the
  // one-line stderr are the two things the user actually meets.
  it('fails with one clean line and a non-zero exit when the DEFAULT vault folder is gone', async () => {
    const goneDefault = path.join(os.tmpdir(), `mv-seed-gone-default-${Date.now()}`);
    // The named vault is fine; only the default one has a path that is not there.
    writeVaultConfig(configFile, { global: goneDefault, clientA: clientDir });

    const errors: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await dispatch(['vault', 'seed', 'clientA']);
    } finally {
      process.stderr.write = realWrite;
    }

    expect(code).toBe(1);
    // One line, no stack: a stack trace would carry "at " frames over many lines.
    expect(errors.join('').trimEnd().split('\n')).toHaveLength(1);
    const message = errors.join('');
    expect(message).toContain('could not be read, so this command did nothing');
    expect(message).toContain("Vault 'global' points to a path that does not exist");
    expect(message).toContain(goneDefault);
    // It stopped before touching the vault the person named.
    expect(fs.readdirSync(clientDir)).toEqual([]);
  });

  it('the shared vault needs no PROJECT.md, so seeding it creates only the two files', async () => {
    const deps = seedDeps();
    await cmdVault(['seed', 'global'], deps);
    // `resolveMemoryFile` refuses file:'project' in the shared vault, so a
    // PROJECT.md there could never be written to.
    expect(fs.existsSync(path.join(globalDir, 'PROJECT.md'))).toBe(false);
    expect(fs.existsSync(path.join(globalDir, 'USER.md'))).toBe(true);
    expect(fs.existsSync(path.join(globalDir, 'MEMORY.md'))).toBe(true);
    expect(missingCuratedFiles(globalDir, 'global')).toEqual([]);
  });

  // The error a person meets BEFORE they know this command exists must name it.
  it('the FILE_NOT_FOUND hint names memory vault seed for an already-registered vault', () => {
    const config: MemoryConfig = {
      vaults: { global: globalDir, clientA: clientDir },
      defaultVault: 'clientA',
      embeddings: { enabled: false, model: 'x' },
    };
    let thrown: unknown;
    try {
      runGet(config, { file: 'memory', vault: 'clientA' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ToolError);
    const err = thrown as ToolError;
    expect(err.code).toBe('FILE_NOT_FOUND');
    expect(err.hint).toContain('memory vault seed clientA');
  });
});

describe('memory vault list', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // No real config, and no MEMORY_VAULT_* from the developer's shell.
    delete process.env['MEMORY_REPO_CONFIG'];
    for (const k of Object.keys(process.env)) {
      if (/^MEMORY_VAULT_/.test(k) || k === 'MEMORY_DEFAULT_VAULT') delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  });

  it('shows every vault, the default one, and the config file they come from', async () => {
    const globalDir = makeDir('mv-g-');
    const clientDir = makeDir('mv-a-');
    const file = path.join(makeDir('mv-cfglist-'), 'config.local.yml');
    fs.writeFileSync(file, `vaults:\n  global: ${JSON.stringify(globalDir)}\n  clientA: ${JSON.stringify(clientDir)}\ndefault_vault: global\n`, 'utf8');
    // loadConfig and resolveConfigSource must agree on the file being shown.
    process.env['MEMORY_CONFIG'] = file;

    const lines: string[] = [];
    await cmdVault(['list'], { out: (line) => lines.push(line), cwd: makeDir('mv-nomarker-') });
    const out = lines.join('\n');
    expect(out).toContain(file);
    expect(out).toContain('global');
    expect(out).toContain('clientA');
    expect(out).toContain(clientDir);
    expect(out).toContain('default here');
    expect(out).toContain('--vault all');
  });

  // A vault registered before the curated files were seeded fails on its FIRST
  // write. This makes the gap visible where the person is already looking.
  it('marks a vault that is missing curated files and names the command that fixes it', async () => {
    const globalDir = makeDir('mv-g3-');
    fs.writeFileSync(path.join(globalDir, 'USER.md'), '# USER\n', 'utf8');
    fs.writeFileSync(path.join(globalDir, 'MEMORY.md'), '# MEMORY\n', 'utf8');
    const clientDir = makeDir('mv-a3-'); // registered before the seeding existed
    const file = path.join(makeDir('mv-cfglist3-'), 'config.local.yml');
    writeVaultConfig(file, { global: globalDir, clientA: clientDir });
    process.env['MEMORY_CONFIG'] = file;

    const lines: string[] = [];
    await cmdVault(['list'], { out: (line) => lines.push(line), cwd: makeDir('mv-nomarker3-') });

    const clientLine = lines.find((line) => line.trimStart().startsWith('clientA '));
    expect(clientLine).toContain('missing USER.md, MEMORY.md, PROJECT.md');
    expect(lines.join('\n')).toContain('memory vault seed <name>');
    // The shared vault holds no PROJECT.md by design, so it must not be marked.
    const globalLine = lines.find((line) => line.trimStart().startsWith('global '));
    expect(globalLine).not.toContain('missing');
  });

  it('says which vaults a search in THIS folder reads, and why the shared one is out', async () => {
    const globalDir = makeDir('mv-g2-');
    const clientDir = makeDir('mv-a2-');
    const file = path.join(makeDir('mv-cfglist2-'), 'config.local.yml');
    fs.writeFileSync(file, `vaults:\n  global: ${JSON.stringify(globalDir)}\n  clientA: ${JSON.stringify(clientDir)}\ndefault_vault: global\n`, 'utf8');
    process.env['MEMORY_CONFIG'] = file;

    const repo = makeDir('mv-marked-');
    fs.writeFileSync(path.join(repo, '.memory.yml'), 'vault: clientA\n', 'utf8');
    const own: string[] = [];
    await cmdVault(['list'], { out: (line) => own.push(line), cwd: repo });
    expect(own.join('\n')).toContain("A search here reads 'clientA', and nothing else.");
    expect(own.join('\n')).toContain('share_global');

    // The same folder with the opt-in reports the shared vault, and says why.
    fs.writeFileSync(path.join(repo, '.memory.yml'), 'vault: clientA\nshare_global: true\n', 'utf8');
    const shared: string[] = [];
    await cmdVault(['list'], { out: (line) => shared.push(line), cwd: repo });
    expect(shared.join('\n')).toContain("reads 'clientA' and the shared 'global' vault");
    expect(shared.join('\n')).toContain('share_global: true');
  });
});

describe('memory search --vault (the human escape hatch)', () => {
  const config: MemoryConfig = {
    vaults: { global: '/tmp/g', clientA: '/tmp/a', clientB: '/tmp/b' },
    defaultVault: 'clientA',
    embeddings: { enabled: false, model: 'x' },
  };

  it('with no flag, a search stays on this folder vault ALONE', () => {
    const vault = resolveSearchVault(config, undefined);
    expect(vault).toBe('clientA');
    expect(readableVaults(config, vault)).toEqual(['clientA']);
  });

  it('the shared vault joins only when the folder opted in with share_global', () => {
    const shared: MemoryConfig = { ...config, shareGlobal: true };
    expect(readableVaults(shared, resolveSearchVault(shared, undefined), shared.shareGlobal))
      .toEqual(['clientA', 'global']);
  });

  it('a folder whose marker could not be honoured reads nothing at all', () => {
    const broken: MemoryConfig = { ...config, markerBroken: true };
    expect(resolveSearchVault(broken, undefined)).toBeNull();
    expect(readableVaults(broken, resolveSearchVault(broken, undefined))).toEqual([]);
  });

  it('--vault all widens to every vault (no filter at all)', () => {
    const vault = resolveSearchVault(config, 'all');
    expect(vault).toBe('all');
    // undefined means "no vault predicate", which is what lets the human cross
    // vaults; the integration test proves such a search returns both clients.
    expect(readableVaults(config, vault)).toBeUndefined();
  });

  it('--vault <name> targets that one vault and nothing else', () => {
    expect(readableVaults(config, resolveSearchVault(config, 'clientB'))).toEqual(['clientB']);
  });

  it('--vault <unknown> is refused with the list of real vaults', () => {
    expect(() => resolveSearchVault(config, 'clientZ')).toThrow(/is not configured/);
    expect(() => resolveSearchVault(config, 'clientZ')).toThrow(/memory vault add clientZ/);
  });
});

describe('addVaultToConfigText', () => {
  it('starts a vaults block when the config has none', () => {
    const out = addVaultToConfigText('default_vault: global\n', 'clientB', 'C:\\vaults\\b');
    expect(out).toContain('default_vault: global');
    const parsed = yaml.load(out) as { vaults: Record<string, string> };
    expect(parsed.vaults['clientB']).toBe('C:\\vaults\\b');
  });

  it('inserts under an empty vaults key', () => {
    const parsed = yaml.load(addVaultToConfigText('vaults:\ndefault_vault: global\n', 'clientB', '/tmp/b')) as { vaults: Record<string, string>; default_vault: string };
    expect(parsed.vaults['clientB']).toBe('/tmp/b');
    expect(parsed.default_vault).toBe('global');
  });

  it('matches the indentation the file already uses', () => {
    const out = addVaultToConfigText('vaults:\n    global: /tmp/g\n', 'clientB', '/tmp/b');
    expect(out).toContain('    clientB: "/tmp/b"');
  });

  it('keeps CRLF files as CRLF', () => {
    const out = addVaultToConfigText('vaults:\r\n  global: /tmp/g\r\n', 'clientB', '/tmp/b');
    expect(out).toContain('\r\n');
    expect(out.includes('\n\n')).toBe(false);
  });

  it('refuses to touch a file that is not valid YAML', () => {
    expect(() => addVaultToConfigText('vaults: [unclosed\n', 'clientB', '/tmp/b')).toThrow(/not valid YAML/);
  });

  it('refuses a one-line (flow style) vaults key and tells the user what to add', () => {
    expect(() => addVaultToConfigText('vaults: {global: /tmp/g}\n', 'clientB', '/tmp/b')).toThrow(/flow style/);
  });
});
