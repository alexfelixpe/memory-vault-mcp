import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { doctorEmbeddings, configDoctorLine } from '../../src/cli/doctor.js';
import type { Embedder } from '../../src/embed/embedder.js';

/**
 * `memory doctor` embedding self-test. Every case is hermetic: the embedder is
 * a stub (no ONNX, no worker, no download), and the model cache location is
 * redirected with MEMORY_CACHE_DIR so the missing/present branches are
 * deterministic on any host.
 */

/** A healthy embedder: warms up and returns a vector of the right dimension. */
function okEmbedder(model = 'multilingual-e5-small', dim = 384): Embedder {
  return {
    model,
    dim,
    isWarm: () => true,
    warmup: async () => {},
    embedQueries: async (texts) => texts.map(() => new Float32Array(dim)),
    embedPassages: async (texts) => texts.map(() => new Float32Array(dim)),
    close: async () => {},
  };
}

/** An embedder that fails to load, standing in for a missing model or unsupported ORT. */
function throwingEmbedder(model = 'multilingual-e5-small', dim = 384): Embedder {
  return {
    model,
    dim,
    isWarm: () => false,
    warmup: async () => {
      throw new Error('onnxruntime-node: no prebuilt binary for this platform');
    },
    embedQueries: async () => {
      throw new Error('unreachable: warmup already failed');
    },
    embedPassages: async () => {
      throw new Error('unreachable: warmup already failed');
    },
    close: async () => {},
  };
}

let tmp: string;
let savedCacheDir: string | undefined;
let savedConfig: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  savedCacheDir = process.env['MEMORY_CACHE_DIR'];
  savedConfig = process.env['MEMORY_CONFIG'];
});

afterEach(() => {
  if (savedCacheDir === undefined) delete process.env['MEMORY_CACHE_DIR'];
  else process.env['MEMORY_CACHE_DIR'] = savedCacheDir;
  if (savedConfig === undefined) delete process.env['MEMORY_CONFIG'];
  else process.env['MEMORY_CONFIG'] = savedConfig;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Writes a temp config.yml (embeddings toggled) and points MEMORY_CONFIG at it. */
function useConfig(enabled: boolean): void {
  const vault = path.join(tmp, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const cfg = path.join(tmp, 'config.yml');
  fs.writeFileSync(
    cfg,
    `vaults:\n  global: ${JSON.stringify(vault)}\ndefault_vault: global\nembeddings:\n  enabled: ${enabled}\n`,
    'utf8',
  );
  process.env['MEMORY_CONFIG'] = cfg;
}

describe('doctorEmbeddings', () => {
  it('reports hybrid search ready when the embedder loads and inference works', async () => {
    useConfig(true);
    const res = await doctorEmbeddings({ makeEmbedder: () => okEmbedder() });

    expect(res.ok).toBe(true);
    expect(res.status).toBe('ready');
    const text = res.lines.join('\n');
    expect(text).toContain('hybrid search ready');
    expect(text).toContain('multilingual-e5-small');
  });

  it('warns lexical-only with the fetch fix when the model is not downloaded', async () => {
    useConfig(true);
    // Empty cache dir: the model folder does not exist -> model_missing.
    process.env['MEMORY_CACHE_DIR'] = path.join(tmp, 'empty-cache');

    const res = await doctorEmbeddings({ makeEmbedder: () => throwingEmbedder() });

    expect(res.ok).toBe(false);
    expect(res.status).toBe('model_missing');
    const text = res.lines.join('\n');
    expect(text).toContain('LEXICAL-ONLY');
    expect(text).toContain('fetch-model');
  });

  it('warns lexical-only naming the platform cause when the model is present but fails to load', async () => {
    useConfig(true);
    // The model folder exists but the embedder still fails -> load_failed.
    const cache = path.join(tmp, 'full-cache');
    fs.mkdirSync(path.join(cache, 'Xenova', 'multilingual-e5-small'), { recursive: true });
    process.env['MEMORY_CACHE_DIR'] = cache;

    const res = await doctorEmbeddings({ makeEmbedder: () => throwingEmbedder() });

    expect(res.ok).toBe(false);
    expect(res.status).toBe('load_failed');
    const text = res.lines.join('\n');
    expect(text).toContain('LEXICAL-ONLY');
    expect(text).toContain('onnxruntime');
  });

  it('does NOT load the model when embeddings are disabled in config (the confirmed bug)', async () => {
    useConfig(false);
    process.env['MEMORY_CACHE_DIR'] = path.join(tmp, 'cache');
    let called = false;

    const res = await doctorEmbeddings({
      makeEmbedder: () => { called = true; return okEmbedder(); },
    });

    // The embedder factory is never invoked -> no worker, no ~130 MB download.
    expect(called).toBe(false);
    expect(res.status).toBe('disabled');
    expect(res.lines.join('\n')).toContain('disabled in config');
    // Nothing created the model cache dir.
    expect(fs.existsSync(path.join(tmp, 'cache'))).toBe(false);
  });

  it('does not crash when the embedder factory itself throws (resolves to a degraded state)', async () => {
    useConfig(true);
    process.env['MEMORY_CACHE_DIR'] = path.join(tmp, 'empty-cache');

    const res = await doctorEmbeddings({
      makeEmbedder: () => {
        throw new Error('Cannot find module onnxruntime-node');
      },
    });

    expect(res.ok).toBe(false);
    expect(['model_missing', 'load_failed']).toContain(res.status);
  });
});

/**
 * The active-config-source line for `memory doctor` (finding 5). Hermetic: the
 * repo-local candidate is redirected with MEMORY_REPO_CONFIG so the real
 * config.local.yml never influences the result.
 */
describe('configDoctorLine', () => {
  let savedRepo: string | undefined;

  beforeEach(() => {
    savedRepo = process.env['MEMORY_REPO_CONFIG'];
    // The top-level afterEach restores MEMORY_CONFIG, so deleting it here is safe.
    delete process.env['MEMORY_CONFIG'];
  });

  afterEach(() => {
    if (savedRepo === undefined) delete process.env['MEMORY_REPO_CONFIG'];
    else process.env['MEMORY_REPO_CONFIG'] = savedRepo;
  });

  it('names a shadowing repo-root config.local.yml as the active source', () => {
    const repoFile = path.join(tmp, 'config.local.yml');
    fs.writeFileSync(repoFile, 'vaults: {}\n', 'utf8');
    process.env['MEMORY_REPO_CONFIG'] = repoFile;

    const line = configDoctorLine();
    expect(line).toContain('config source:');
    expect(line).toContain(repoFile);
    expect(line).toContain('config.local.yml');
  });

  it('reports the MEMORY_CONFIG file as the active source when that env var is set', () => {
    const envFile = path.join(tmp, 'my-config.yml');
    fs.writeFileSync(envFile, 'vaults: {}\n', 'utf8');
    process.env['MEMORY_CONFIG'] = envFile;

    const line = configDoctorLine();
    expect(line).toContain(envFile);
    expect(line).toContain('MEMORY_CONFIG');
  });
});
