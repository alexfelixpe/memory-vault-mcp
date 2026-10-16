import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProjectMarker, readProjectMarker, loadConfig, printConfigWarning } from '../../src/core/config.js';

/**
 * The `.memory.yml` marker decides which vault a repo belongs to — which now
 * also decides which memory an agent in that repo may READ. It had no test at
 * all, and a marker naming an unknown vault was dropped in silence. These cases
 * pin the reading of the file and the loud fallback.
 */

let savedEnv: NodeJS.ProcessEnv;
const tmpDirs: string[] = [];

/** A temp directory that stands in for a vault root or a repo. */
function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** A repo directory holding exactly this .memory.yml content. */
function makeRepo(markerContent: string): string {
  const repo = makeDir('mv-repo-');
  fs.writeFileSync(path.join(repo, '.memory.yml'), markerContent, 'utf8');
  return repo;
}

/** A config file naming the given vaults, with `global` as the default. */
function writeConfig(vaults: Record<string, string>): string {
  const dir = makeDir('mv-cfg-');
  const file = path.join(dir, 'config.local.yml');
  const body = ['vaults:', ...Object.entries(vaults).map(([n, p]) => `  ${n}: ${JSON.stringify(p)}`), 'default_vault: global', ''];
  fs.writeFileSync(file, body.join('\n'), 'utf8');
  return file;
}

beforeEach(() => {
  savedEnv = { ...process.env };
  // No real config or vault variables may reach these cases.
  delete process.env['MEMORY_CONFIG'];
  delete process.env['MEMORY_REPO_CONFIG'];
  for (const k of Object.keys(process.env)) {
    if (/^MEMORY_VAULT_/.test(k) || k === 'MEMORY_DEFAULT_VAULT') delete process.env[k];
  }
  process.env['MEMORY_APPDATA_DIR'] = makeDir('mv-appdata-');
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('findProjectMarker', () => {
  it('reads the vault name from a valid .memory.yml', () => {
    expect(findProjectMarker(makeRepo('vault: clientA\n'))).toEqual({ vault: 'clientA' });
  });

  it('finds the marker from a nested folder, walking up to the repo root', () => {
    const repo = makeRepo('vault: clientA\n');
    const nested = path.join(repo, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    expect(findProjectMarker(nested)).toEqual({ vault: 'clientA' });
  });

  it('returns undefined for malformed YAML instead of throwing', () => {
    // A marker a human broke by hand must never stop the CLI or the daemon.
    expect(findProjectMarker(makeRepo('vault: [unclosed\n'))).toBeUndefined();
  });

  it('returns undefined when the file has no vault key', () => {
    expect(findProjectMarker(makeRepo('something_else: 1\n'))).toBeUndefined();
  });

  it('returns undefined when there is no marker anywhere above', () => {
    expect(findProjectMarker(makeDir('mv-nomarker-'))).toBeUndefined();
  });
});

describe('readProjectMarker tells the three cases apart', () => {
  // The read scope has to treat "no marker" and "broken marker" differently, so
  // collapsing both to undefined (what findProjectMarker does) is not enough.
  it('a valid marker reports the vault name it asks for, and no sharing by default', () => {
    const repo = makeRepo('vault: clientA\n');
    expect(readProjectMarker(repo)).toEqual({
      kind: 'named', vault: 'clientA', shareGlobal: false, file: path.join(repo, '.memory.yml'),
    });
  });

  it('share_global: true is read, and only the literal true turns sharing on', () => {
    const on = makeRepo('vault: clientA\nshare_global: true\n');
    expect(readProjectMarker(on)).toEqual({
      kind: 'named', vault: 'clientA', shareGlobal: true, file: path.join(on, '.memory.yml'),
    });
    const off = makeRepo('vault: clientA\nshare_global: false\n');
    expect(readProjectMarker(off)).toMatchObject({ kind: 'named', shareGlobal: false });
  });

  it('an unknown extra key does not break the marker, but a wrong share_global type does', () => {
    // Tolerant to what it does not know: a stray key must not cost this repo its
    // whole memory. Strict about the key it DOES know: reading the string "true"
    // as either answer would be a silent, wrong decision about a permission.
    const extra = makeRepo('vault: clientA\nsomething_new: 42\n');
    expect(readProjectMarker(extra)).toMatchObject({ kind: 'named', vault: 'clientA', shareGlobal: false });

    const wrongType = makeRepo('vault: clientA\nshare_global: "true"\n');
    expect(readProjectMarker(wrongType)).toEqual({ kind: 'malformed', file: path.join(wrongType, '.memory.yml') });
  });

  it('no marker anywhere above is its own case', () => {
    expect(readProjectMarker(makeDir('mv-nomarker-'))).toEqual({ kind: 'none' });
  });

  it('broken YAML is malformed, not missing, and names the file to fix', () => {
    const repo = makeRepo('vault: [unclosed\n');
    expect(readProjectMarker(repo)).toEqual({ kind: 'malformed', file: path.join(repo, '.memory.yml') });
  });

  it('a marker with no vault key is malformed too', () => {
    const repo = makeRepo('something_else: 1\n');
    expect(readProjectMarker(repo)).toEqual({ kind: 'malformed', file: path.join(repo, '.memory.yml') });
  });
});

describe('loadConfig with a repo marker', () => {
  it('a valid marker chooses the default vault for that repo', () => {
    const global = makeDir('mv-vault-');
    const a = makeDir('mv-vault-');
    const cfg = loadConfig({ configPath: writeConfig({ global, clientA: a }), cwd: makeRepo('vault: clientA\n') });
    expect(cfg.defaultVault).toBe('clientA');
    expect(cfg.markerWarning).toBeUndefined();
    expect(cfg.markerBroken).toBeUndefined();
    // No sharing unless the marker asks for it.
    expect(cfg.shareGlobal).toBe(false);
  });

  it('share_global: true in the marker reaches the config as a read permission', () => {
    const global = makeDir('mv-vault-');
    const a = makeDir('mv-vault-');
    const cfg = loadConfig({
      configPath: writeConfig({ global, clientA: a }),
      cwd: makeRepo('vault: clientA\nshare_global: true\n'),
    });
    expect(cfg.defaultVault).toBe('clientA');
    expect(cfg.shareGlobal).toBe(true);
  });

  it('a marker naming an unknown vault is NOT silent: it warns and says which vault is used', () => {
    const global = makeDir('mv-vault-');
    const cfg = loadConfig({ configPath: writeConfig({ global }), cwd: makeRepo('vault: clientZ\n') });
    // defaultVault itself is untouched (nothing re-points it)...
    expect(cfg.defaultVault).toBe('global');
    // ...and the mismatch is visible, with the name asked for, what happens to
    // reads and writes now, and the command that fixes it.
    expect(cfg.markerWarning).toContain('clientZ');
    expect(cfg.markerWarning).toContain('not configured');
    expect(cfg.markerWarning).toMatch(/every write from here is refused/i);
    expect(cfg.markerWarning).toMatch(/reads no vault at all and finds nothing/i);
    expect(cfg.markerWarning).toContain('memory vault add clientZ');
    // And it is flagged for the read AND write paths, which fail closed on it.
    expect(cfg.markerBroken).toBe(true);
    // The exact file to fix is carried too, so an error hint can name it.
    expect(cfg.markerFile?.endsWith('.memory.yml')).toBe(true);
    expect(cfg.markerVault).toBe('clientZ');
  });

  it('malformed marker YAML leaves the default vault alone, warns, and flags the read path', () => {
    const global = makeDir('mv-vault-');
    const cfg = loadConfig({ configPath: writeConfig({ global }), cwd: makeRepo('vault: [unclosed\n') });
    expect(cfg.defaultVault).toBe('global');
    // A marker a human broke by hand used to be dropped in silence. It is the
    // same danger as a typo'd vault name, so it warns and fails closed too.
    expect(cfg.markerWarning).toContain('.memory.yml');
    expect(cfg.markerWarning).toContain('could not be read');
    expect(cfg.markerWarning).toMatch(/every write from here is refused/i);
    expect(cfg.markerWarning).toMatch(/reads no vault at all and finds nothing/i);
    expect(cfg.markerBroken).toBe(true);
    expect(cfg.markerFile?.endsWith('.memory.yml')).toBe(true);
    // No usable name in the file, so there is none to echo back.
    expect(cfg.markerVault).toBeUndefined();
  });

  it('no marker at all changes nothing: no warning, no fail-closed flag', () => {
    const global = makeDir('mv-vault-');
    const cfg = loadConfig({ configPath: writeConfig({ global }), cwd: makeDir('mv-nomarker-') });
    expect(cfg.defaultVault).toBe('global');
    expect(cfg.markerWarning).toBeUndefined();
    expect(cfg.markerBroken).toBeUndefined();
  });

  it('printConfigWarning writes the warning once, and nothing when there is none', () => {
    const lines: string[] = [];
    printConfigWarning({ vaults: {}, defaultVault: 'global', embeddings: { enabled: false, model: 'x' }, markerWarning: 'boom' }, (l) => lines.push(l));
    expect(lines).toEqual(['warning: boom']);
    lines.length = 0;
    printConfigWarning({ vaults: {}, defaultVault: 'global', embeddings: { enabled: false, model: 'x' } }, (l) => lines.push(l));
    expect(lines).toEqual([]);
  });
});
