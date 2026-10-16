import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, resolveConfigSource, describeConfigOrigin } from '../core/config.js';
import { cacheDir } from '../core/paths.js';
import { EmbedClient } from '../embed/client.js';
import { DEFAULT_EMBED_MODEL, EMBED_REPO, type Embedder } from '../embed/embedder.js';

/**
 * The embedding half of `memory doctor`. Split out of memory.ts so it can be
 * imported and tested without running the CLI's top-level main().
 *
 * The top adoption risk this catches: if the embedding model or
 * onnxruntime-node is missing or unsupported, hybrid search silently drops to
 * lexical-only and the user is never told. This self-test actually loads the
 * embedder and runs ONE real inference, then reports which of three states the
 * machine is in. It NEVER throws: a failure is a reported degraded state, not a
 * crash, because lexical search still works.
 */

/**
 * The "which config file actually wins" line for `memory doctor` (finding 5).
 * loadConfig prefers a repo-root config.local.yml (and MEMORY_CONFIG) over the
 * OS-dir config `memory init` writes, so a user who re-scoped the vault in a
 * shadowed file would otherwise never see WHY it was ignored. Pure; never throws.
 *
 * Wiring: cmdDoctor lives in src/cli/memory.ts (owned by a parallel task), so it
 * is not edited here. To surface this in `memory doctor`, add one line to
 * cmdDoctor: `console.log(configDoctorLine());` (right after the `config` check).
 */
export function configDoctorLine(): string {
  const src = resolveConfigSource({});
  const present = src.exists ? '' : ' (not present yet; built-in defaults apply)';
  return `ok    config source: ${src.path} (${describeConfigOrigin(src.origin)})${present}`;
}

export interface DoctorDeps {
  /** Factory for the embedder under test; defaults to a real EmbedClient. Tests inject a stub. */
  makeEmbedder?: (model: string) => Embedder;
  /** Cap on the model load; keeps doctor from hanging on a first-run download. */
  warmupTimeoutMs?: number;
  /** Cap on the single inference. */
  inferTimeoutMs?: number;
}

export interface EmbedDoctorResult {
  /** true => hybrid search is ready; false => running lexical-only. */
  ok: boolean;
  status: 'ready' | 'model_missing' | 'load_failed' | 'disabled';
  /** Human-facing lines, already formatted with the ok/WARN prefix doctor prints. */
  lines: string[];
}

/**
 * Loads the embedder and runs one real inference on a short string. Returns a
 * structured result instead of printing, so both the CLI and the tests consume
 * the same outcome.
 */
export async function doctorEmbeddings(deps: DoctorDeps = {}): Promise<EmbedDoctorResult> {
  // The model name comes from config, but a broken config must not stop the
  // self-test: the config check reports its own failure, so fall back to the
  // default model here and still exercise embeddings.
  let model = DEFAULT_EMBED_MODEL;
  let enabled = true;
  try {
    const cfg = loadConfig({ cwd: process.cwd() });
    model = cfg.embeddings.model;
    enabled = cfg.embeddings.enabled;
  } catch {
    // fall back to the default model, embeddings assumed on
  }

  // Embeddings turned off in config: do NOT load or download the model. Loading
  // it here would pull ~130 MB for a feature the user disabled and falsely
  // report "hybrid search ready" (confirmed bug). Report the keyword-only state
  // and return before touching the embedder.
  if (!enabled) {
    return {
      ok: true,
      status: 'disabled',
      lines: ['ok    embeddings: disabled in config (search is keyword-only)'],
    };
  }

  const make = deps.makeEmbedder ?? ((m): Embedder => new EmbedClient({
    model: m,
    // Short timeouts so doctor never hangs; a real download on first run is
    // caught as a degraded (model_missing) state instead.
    warmupTimeoutMs: deps.warmupTimeoutMs ?? 30_000,
    embedTimeoutMs: deps.inferTimeoutMs ?? 15_000,
  }));

  let embedder: Embedder | undefined;
  try {
    embedder = make(model);
    await embedder.warmup();
    const [vec] = await embedder.embedQueries(['memory doctor embedding self-test']);
    // A wrong dimension means a loaded-but-wrong model; treat it as a failure.
    if (!vec || vec.length !== embedder.dim) {
      throw new Error(`inference returned ${vec ? vec.length : 0} numbers, expected ${embedder.dim}`);
    }
    return {
      ok: true,
      status: 'ready',
      lines: [`ok    embeddings: hybrid search ready (model ${embedder.model} loaded, embedding works)`],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The embedder may fail before it is even assigned (factory throws); use
    // the resolved model name in that case.
    return degradedResult(embedder?.model ?? model, msg);
  } finally {
    // Closing a dead or never-started worker is harmless; swallow any error.
    try {
      await embedder?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Builds the LOUD lexical-only warning. Distinguishes "model not downloaded"
 * from "present but fails to load on this platform" by whether the model folder
 * exists in the shared cache dir — the same folder the worker reads from.
 */
function degradedResult(model: string, errMsg: string): EmbedDoctorResult {
  const repo = EMBED_REPO[model] ?? model;
  // transformers.js stores the model at <cacheDir>/<org>/<name>; split the repo
  // so the separator is the host's, not a literal '/'.
  const modelDir = path.join(cacheDir(), ...repo.split('/'));
  const downloaded = fs.existsSync(modelDir);
  const banner = 'WARN  embeddings: HYBRID SEARCH IS OFF -- search is running in LEXICAL-ONLY mode.';

  if (!downloaded) {
    return {
      ok: false,
      status: 'model_missing',
      lines: [
        banner,
        `      cause: the embedding model "${model}" is not downloaded (looked in ${modelDir}).`,
        '      fix:   run  npm run fetch-model   -- or run one search and the daemon downloads it on first use.',
      ],
    };
  }
  return {
    ok: false,
    status: 'load_failed',
    lines: [
      banner,
      `      cause: model "${model}" is present but failed to load on this platform: ${errMsg}`,
      '      likely onnxruntime-node has no prebuilt binary for this OS/arch, or the optional',
      '      deps (@huggingface/transformers, onnxruntime-node) are not installed.',
      '      fix:   reinstall dependencies for this platform; until then search stays lexical-only.',
    ],
  };
}
