import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cacheDir as srcCacheDir } from '../../src/core/paths.js';

/**
 * The pre-download script and the runtime worker must read the model from ONE
 * folder. Before the fix, fetch-model.mjs hardcoded %LOCALAPPDATA%\memory\models
 * while the worker used cacheDir() from core/paths — so on macOS/Linux the two
 * pointed at different folders and the model was downloaded twice.
 *
 * Both now resolve the location through cacheDir(). These cases lock that
 * invariant without triggering a real (100MB+) download.
 */

const distUrl = new URL('../../dist/core/paths.js', import.meta.url);
const distExists = fs.existsSync(fileURLToPath(distUrl));

const fetchScript = fs.readFileSync(
  fileURLToPath(new URL('../../scripts/fetch-model.mjs', import.meta.url)),
  'utf8',
);
const workerSrc = fs.readFileSync(
  fileURLToPath(new URL('../../src/embed/worker.ts', import.meta.url)),
  'utf8',
);

describe('fetch-model and the worker agree on the model cache dir', () => {
  // fetch-model imports cacheDir() from the COMPILED paths module; the worker
  // (in src, compiled to that same module) imports it too. On this OS the two
  // must return the identical folder.
  it.skipIf(!distExists)('dist cacheDir() (fetch-model) equals src cacheDir() (worker) on this OS', async () => {
    const dist = (await import(distUrl.href)) as { cacheDir: () => string };
    expect(dist.cacheDir()).toBe(srcCacheDir());
  });

  it('fetch-model.mjs resolves cacheDir() from the compiled paths module', () => {
    expect(fetchScript).toContain('../dist/core/paths.js');
    expect(fetchScript).toContain('env.cacheDir = cacheDir()');
    // The old, wrong, platform-specific hardcode must be gone.
    expect(fetchScript).not.toContain('process.env.LOCALAPPDATA');
  });

  it('the worker sets its model cache dir from the same cacheDir() resolver', () => {
    expect(workerSrc).toContain('env.cacheDir = cacheDir()');
  });

  it('the worker keeps the ONNX CPU memory arena off (the smoke test passes either way, so this guards the RAM fix)', () => {
    // Line comments are stripped first, and the option must sit inside session_options:
    // pipeline() silently drops unknown top-level keys.
    const code = workerSrc.replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(/session_options:\s*\{[^}]*enableCpuMemArena:\s*false/);
  });
});
