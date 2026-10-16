import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openIndexDb } from '../../src/index/db.js';
import { reconcileVault } from '../../src/index/reconcile.js';
import { loadRegistryVocab } from '../../src/core/identifiers.js';
import { buildRetrievalPush } from '../../src/daemon/capture/push.js';
import { makeTmpVault, makeTmpIndexDir, type TmpVault } from '../helpers/tmp-vault.js';
import type { MemoryConfig } from '../../src/core/config.js';

/**
 * The SessionStart retrieval push must inject real memories only. The curated
 * files (USER/MEMORY) open with a descriptive header ("Who you are…", the char
 * budget, the edit rules) that is prose ABOUT the file, not a memory; it used to
 * surface in the push as if it were one. This pins that the header is filtered
 * even when it matches the query, while a real entry still surfaces.
 */

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

// The intro is the STRONGEST match (most query terms), so without the filter it
// ranks #1 for USER.md and would be the per-file pick. Several real entries also
// match strongly, so the BM25 min-max threshold keeps them (a tiny 2-hit pool
// would normalize the weaker hit to 0 and drop it — an artifact, not the fix).
const USER_MD = `# USER

Who you are: this file describes the widget deployment pipeline release budget and edit rules. INTRO_ONLY_MARKER widget deployment pipeline release.

## Perfil

- Alice leads the widget deployment pipeline release train. ENTRY_MARKER_A widget deployment pipeline release. <!-- mem id=01ARZ3NDEKTSV4RRFFQ69G5FA1 src:human -->

## Trabalho

- The widget deployment pipeline runs nightly for every release. ENTRY_MARKER_B widget deployment pipeline release. <!-- mem id=01ARZ3NDEKTSV4RRFFQ69G5FA2 src:human -->

## Ferramentas

- Widget deployment uses the release pipeline tooling daily. ENTRY_MARKER_C widget deployment pipeline release. <!-- mem id=01ARZ3NDEKTSV4RRFFQ69G5FA3 src:human -->
`;

const MEMORY_MD = `# MEMORY

Durable facts and conventions live here for the widget team. MEMORY_INTRO_MARKER widget.

## Decisoes <!-- auto -->

- Nothing worth surfacing yet.
`;

describe('retrieval push excludes the curated file-description header', () => {
  let vault: TmpVault;
  let index: ReturnType<typeof makeTmpIndexDir>;
  let db: Database.Database;
  let cwd: string;
  let config: MemoryConfig;

  beforeEach(() => {
    vault = makeTmpVault({ 'USER.md': USER_MD, 'MEMORY.md': MEMORY_MD }, { eol: 'lf' });
    index = makeTmpIndexDir();
    db = openIndexDb({ rootDir: index.root });
    const vocab = loadRegistryVocab(vault.root);
    reconcileVault({ db, vaultName: 'global', vaultRoot: vault.root, vocab });
    config = { vaults: { global: vault.root }, defaultVault: 'global', embeddings: { enabled: false, model: 'x' } };

    // A git repo whose latest commit subject seeds the push query with words
    // present in BOTH the header prose and the real entry, so without the filter
    // the header would rank and surface.
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mempush-'));
    git(cwd, 'init', '-q');
    git(cwd, 'config', 'user.email', 'test@example.com');
    git(cwd, 'config', 'user.name', 'Test');
    git(cwd, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(cwd, 'app.ts'), '// code\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-q', '-m', 'widget deployment pipeline release notes');
  });

  afterEach(() => {
    db.close();
    index.cleanup();
    vault.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5 });
  });

  it('end-to-end: surfaces real curated entries and never the file-description header', async () => {
    const push = await buildRetrievalPush(db, config, cwd);
    // The descriptive header prose of the curated files never appears as a memory.
    expect(push).not.toContain('INTRO_ONLY_MARKER');
    expect(push).not.toContain('MEMORY_INTRO_MARKER');
    // Real entries under a '## Section' still surface (the push is not just empty).
    expect(push).toMatch(/ENTRY_MARKER_[ABC]/);
  });
});
