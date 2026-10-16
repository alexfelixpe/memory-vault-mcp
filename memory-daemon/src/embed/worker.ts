import readline from 'node:readline';
import { cacheDir } from '../core/paths.js';
import { EMBED_REPO } from './embedder.js';

/**
 * Embedding worker: a separate child_process speaking JSONL over stdio.
 * Loads the ONNX model ONCE; a crash here does not bring down the daemon (the
 * client restarts the worker) and the model's RAM becomes intermittent.
 *
 * Protocol: { id, op: 'warmup' } | { id, op: 'embed', kind, texts } ->
 * { id, ok: true, vectors?: base64[] } | { id, ok: false, error }.
 */

interface Req {
  id: string;
  op: 'warmup' | 'embed';
  kind?: 'query' | 'passage';
  texts?: string[];
}

type FeatureExtractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

const modelName = process.env['MEMORY_EMBED_MODEL'] ?? 'multilingual-e5-small';

let extractor: FeatureExtractor | undefined;

async function load(): Promise<FeatureExtractor> {
  if (extractor) return extractor;
  const { pipeline, env } = await import('@huggingface/transformers');
  // Per-OS model cache: %LOCALAPPDATA%\memory\models on Windows (unchanged),
  // ~/Library/Caches/memory on macOS, $XDG_CACHE_HOME/memory on Linux.
  env.cacheDir = cacheDir();
  // The CPU memory arena stays off: with it on, the worker's RSS grew from about
  // 500 MB to about 1.5 GB over 320 session chunks in batches of 16 and never
  // came back. Off, it stays near 540 MB at the same speed. The memory pattern
  // stays on, because turning it off too cost about 1.6x the time.
  const pipe = await pipeline('feature-extraction', EMBED_REPO[modelName] ?? modelName, {
    dtype: 'q8',
    session_options: { enableCpuMemArena: false },
  });
  extractor = pipe as unknown as FeatureExtractor;
  return extractor;
}

function toBase64(vec: number[]): string {
  return Buffer.from(new Float32Array(vec).buffer).toString('base64');
}

async function handle(req: Req): Promise<void> {
  try {
    const ex = await load();
    if (req.op === 'warmup') {
      // One real inference: the first cold embed pays for compiling the graph.
      await ex(['query: warmup'], { pooling: 'mean', normalize: true });
      respond({ id: req.id, ok: true });
      return;
    }
    const prefix = req.kind === 'query' ? 'query: ' : 'passage: ';
    const out = await ex((req.texts ?? []).map((t) => prefix + t), { pooling: 'mean', normalize: true });
    respond({ id: req.id, ok: true, vectors: out.tolist().map(toBase64) });
  } catch (e) {
    respond({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

function respond(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (line.trim() === '') return;
  try {
    void handle(JSON.parse(line) as Req);
  } catch {
    respond({ id: '', ok: false, error: 'line is not JSON' });
  }
});
rl.on('close', () => process.exit(0));
