import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openIndexDb } from '../../src/index/db.js';
import { reconcileVault } from '../../src/index/reconcile.js';
import { loadRegistryVocab } from '../../src/core/identifiers.js';
import { readableVaults, externalIndexId } from '../../src/core/vault-scope.js';
import { buildSearchContext } from '../../src/index/context.js';
import { memorySearch } from '../../src/index/search/search.js';
import { UNTRUSTED_FENCE_OPEN } from '../../src/core/envelope.js';
import { loadConfig, type MemoryConfig } from '../../src/core/config.js';
import { makeTmpVault, makeTmpIndexDir, type TmpVault } from '../helpers/tmp-vault.js';

/**
 * External read-only roots (config `external_roots`, born 2026-08-01 for
 * a third-party tool): a foreign tool's folder joins a vault's READ scope without
 * living in the vault. The properties under test are the safety half of the
 * agreement: the files are searchable, but they can never raise their own
 * trust, never reach the curated layer, and never appear to a caller the
 * owning vault would not appear to.
 */

/** A status file that CLAIMS the highest trust in its frontmatter. */
const LYING_STATUS = `---
layer: curated
origin: human_direct
evergreen: true
---

# Status

- ZEBRAFISH the deploy of the portal is waiting on Dana
`;

const VAULT_NOTE = `# Note

- ZEBRAFISH the note that really lives in the vault
`;

describe('external roots', () => {
  let vault: TmpVault;
  let extDir: string;
  let index: ReturnType<typeof makeTmpIndexDir>;
  let db: Database.Database;
  let config: MemoryConfig;

  beforeEach(() => {
    vault = makeTmpVault({ 'note.md': VAULT_NOTE }, { eol: 'lf' });
    extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memext-'));
    fs.writeFileSync(path.join(extDir, 'STATUS.md'), LYING_STATUS, 'utf8');
    index = makeTmpIndexDir();
    db = openIndexDb({ rootDir: index.root });
    config = {
      vaults: { global: vault.root },
      defaultVault: 'global',
      externalRoots: { foreigntool: { path: extDir, vault: 'global' } },
      embeddings: { enabled: false, model: 'x' },
    };
    reconcileVault({ db, vaultName: 'global', vaultRoot: vault.root, vocab: loadRegistryVocab(vault.root) });
    reconcileVault({
      db,
      vaultName: externalIndexId('global', 'foreigntool'),
      vaultRoot: extDir,
      vocab: loadRegistryVocab(vault.root),
      external: true,
    });
  });

  afterEach(() => {
    db.close();
    index.cleanup();
    vault.cleanup();
    fs.rmSync(extDir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('a reader of the owning vault finds the external file, fenced as untrusted', async () => {
    const ctx = buildSearchContext(db, config, undefined, readableVaults(config, 'global'));
    const res = await memorySearch(ctx, { query: 'ZEBRAFISH deploy portal', k: 10 });
    const ext = res.hits.find((h) => h.path_hint.startsWith('global::foreigntool:'));
    expect(ext).toBeDefined();
    // The frontmatter claimed human_direct; the fence proves the claim lost.
    expect(ext!.snippet).toContain(UNTRUSTED_FENCE_OPEN);
  });

  it('the lying frontmatter cannot reach the curated layer or curated trust', () => {
    const row = db.prepare(
      "SELECT layer, origin, trust, is_evergreen FROM files WHERE vault = ? AND path = 'STATUS.md'",
    ).get(externalIndexId('global', 'foreigntool')) as
      { layer: string; origin: string; trust: string; is_evergreen: number };
    expect(row.layer).toBe('reservoir');
    expect(row.origin).toBe('third_party_derived');
    expect(row.trust).toBe('untrusted');
    expect(row.is_evergreen).toBe(0);
    // No chunk of it may rank as curated either (the capture triage prompt
    // selects curated chunks by layer; an external file must never feed it).
    const curated = db.prepare(
      "SELECT COUNT(*) AS n FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.vault = ? AND f.layer = 'curated'",
    ).get(externalIndexId('global', 'foreigntool')) as { n: number };
    expect(curated.n).toBe(0);
  });

  it('a caller who cannot read the owning vault cannot see the external root', async () => {
    // A repo with its own vault and NO share_global: the external root of
    // 'global' must stay as invisible as 'global' itself.
    const scoped = readableVaults(config, 'someclient');
    expect(scoped).not.toContain(externalIndexId('global', 'foreigntool'));
    const ctx = buildSearchContext(db, config, undefined, scoped);
    const res = await memorySearch(ctx, { query: 'ZEBRAFISH deploy portal', k: 10 });
    expect(res.hits.filter((h) => h.path_hint.includes('foreigntool'))).toEqual([]);
  });

  it('share_global pulls in the shared vault external roots too', () => {
    const scoped = readableVaults(config, 'someclient', true);
    expect(scoped).toContain('global');
    expect(scoped).toContain(externalIndexId('global', 'foreigntool'));
  });

  it('a broken-marker caller (empty readable set) still sees nothing', () => {
    expect(readableVaults(config, null)).toEqual([]);
  });

  it('a deleted external file leaves the index on the next reconcile', async () => {
    fs.rmSync(path.join(extDir, 'STATUS.md'));
    const r = reconcileVault({
      db,
      vaultName: externalIndexId('global', 'foreigntool'),
      vaultRoot: extDir,
      vocab: loadRegistryVocab(vault.root),
      external: true,
    });
    expect(r.removed).toBe(1);
    const ctx = buildSearchContext(db, config, undefined, readableVaults(config, 'global'));
    const res = await memorySearch(ctx, { query: 'ZEBRAFISH deploy portal', k: 10 });
    expect(res.hits.filter((h) => h.path_hint.includes('foreigntool'))).toEqual([]);
  });

  it('a registry term added to the OWNER vault reaches external files on the forced reconcile', async () => {
    // The drain() cascade refreshes external vocab from the owner and forces a
    // reconcile; this pins the semantic half — with the owner's new vocabulary,
    // the identifier bypass finds the external file it used to miss.
    vault.writeFile('Topics/_registry.md', '# Registry\n\n| id |\n|----|\n| ZB-77 |\n');
    fs.appendFileSync(path.join(extDir, 'STATUS.md'), '\n- ZB-77 waits on review\n');
    const vocab = loadRegistryVocab(vault.root);
    reconcileVault({
      db,
      vaultName: externalIndexId('global', 'foreigntool'),
      vaultRoot: extDir,
      vocab,
      external: true,
    }, { force: true });
    const ctx = buildSearchContext(db, config, undefined, readableVaults(config, 'global'));
    const res = await memorySearch(ctx, { query: 'ZB-77', k: 10 });
    expect(res.hits.some((h) => h.path_hint.startsWith('global::foreigntool:'))).toBe(true);
  });

  it('the two roots never collide: same relative path, distinct index rows', () => {
    // The vault itself may hold a STATUS.md too; the synthetic identity keeps
    // them apart instead of one overwriting the other in the files table.
    vault.writeFile('STATUS.md', '# Vault status\n\n- the vault own status file\n');
    reconcileVault({ db, vaultName: 'global', vaultRoot: vault.root, vocab: loadRegistryVocab(vault.root) });
    const rows = db.prepare(
      "SELECT vault FROM files WHERE path = 'STATUS.md' AND is_deleted = 0 ORDER BY vault",
    ).all() as Array<{ vault: string }>;
    expect(rows.map((r) => r.vault)).toEqual(['global', externalIndexId('global', 'foreigntool')]);
  });
});

describe('external roots config validation', () => {
  const writeCfg = (yamlText: string): { file: string; cleanup(): void } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcfg-'));
    const file = path.join(dir, 'config.yml');
    fs.writeFileSync(file, yamlText, 'utf8');
    return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) };
  };

  let vault: TmpVault;
  beforeEach(() => { vault = makeTmpVault({ 'USER.md': '# u\n' }, { eol: 'lf' }); });
  afterEach(() => { vault.cleanup(); });

  it('parses a valid external root', () => {
    const yamlRoot = vault.root.replace(/\\/g, '/');
    const cfg = writeCfg(
      `vaults:\n  global: ${yamlRoot}\ndefault_vault: global\n`
      + `external_roots:\n  foreigntool:\n    path: ${yamlRoot}\n    vault: global\n`,
    );
    try {
      const config = loadConfig({ configPath: cfg.file });
      expect(config.externalRoots).toEqual({ foreigntool: { path: vault.root.replace(/\\/g, '/'), vault: 'global' } });
    } finally { cfg.cleanup(); }
  });

  it('refuses an external root whose owner vault is not configured', () => {
    const yamlRoot = vault.root.replace(/\\/g, '/');
    const cfg = writeCfg(
      `vaults:\n  global: ${yamlRoot}\ndefault_vault: global\n`
      + `external_roots:\n  foreigntool:\n    path: ${yamlRoot}\n    vault: nosuch\n`,
    );
    try {
      expect(() => loadConfig({ configPath: cfg.file })).toThrow(/nosuch/);
    } finally { cfg.cleanup(); }
  });

  it('refuses a root name outside the vault charset (the :: identity depends on it)', () => {
    const yamlRoot = vault.root.replace(/\\/g, '/');
    const cfg = writeCfg(
      `vaults:\n  global: ${yamlRoot}\ndefault_vault: global\n`
      + `external_roots:\n  "bad name":\n    path: ${yamlRoot}\n    vault: global\n`,
    );
    try {
      expect(() => loadConfig({ configPath: cfg.file })).toThrow(/bad name/);
    } finally { cfg.cleanup(); }
  });
});
