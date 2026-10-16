#!/usr/bin/env node
// Pre-downloads the ONNX embedding model into the SAME cache directory the
// embedding worker reads from at runtime. Both this script and
// src/embed/worker.ts set `env.cacheDir = cacheDir()` from core/paths, so the
// pre-download and the runtime read from ONE folder on every OS. The old code
// hardcoded %LOCALAPPDATA%\memory\models, which matched the worker only on
// Windows; on macOS/Linux the worker's cacheDir() pointed elsewhere and the
// model was downloaded a second time.
//
// Standalone pre-download. Runs a smoke inference at the end.
// Usage: node scripts/fetch-model.mjs [model]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pipeline, env } from '@huggingface/transformers';

// Resolve cacheDir() and the repo map from the COMPILED output — the very
// module the worker imports at runtime — so the two can never disagree. A
// pre-download run needs a build first.
const pathsUrl = new URL('../dist/core/paths.js', import.meta.url);
const embedderUrl = new URL('../dist/embed/embedder.js', import.meta.url);
if (!fs.existsSync(fileURLToPath(pathsUrl)) || !fs.existsSync(fileURLToPath(embedderUrl))) {
  console.error('dist not found. Run `npm run build` first, then re-run this script.');
  process.exit(1);
}
const { cacheDir } = await import(pathsUrl.href);
const { EMBED_REPO } = await import(embedderUrl.href);

// Match the worker's model resolution: argv, then env, then default.
const model = process.argv[2] ?? process.env.MEMORY_EMBED_MODEL ?? 'multilingual-e5-small';

// The same field the worker sets, resolved by the same cacheDir(): one folder
// per OS for both the pre-download and the runtime read.
env.cacheDir = cacheDir();
console.log(`downloading ${model} to ${env.cacheDir} ...`);

// SUPPLY-CHAIN FOLLOW-UP (deferred): this pulls the HuggingFace "main" ref,
// which is a moving pointer. Pinning `revision` to a specific commit SHA per
// repo is the hardening step; it needs the SHA for each repo, so it is tracked
// separately and intentionally not done here.
const t0 = Date.now();
const extractor = await pipeline('feature-extraction', EMBED_REPO[model] ?? model, { dtype: 'q8' });
const out = await extractor(['query: smoke test'], { pooling: 'mean', normalize: true });
const dim = out.tolist()[0].length;
console.log(`ok: model ready in ${Date.now() - t0} ms, dim ${dim}`);
