/**
 * Single embedding interface. e5 requires distinct prefixes for query and
 * passage ('query: ' / 'passage: '); the implementer handles that.
 * Vectors are always normalized: cosine becomes an inner product.
 */

export const DEFAULT_EMBED_MODEL = 'multilingual-e5-small';
export const EMBED_DIM: Record<string, number> = {
  'multilingual-e5-small': 384,
  'bge-m3': 1024,
};

/**
 * Short model name -> HuggingFace ONNX repo (Xenova family). Single source of
 * truth: the runtime worker, the `memory doctor` self-test, and the
 * pre-download script all resolve the repo through this map, so they can never
 * drift to different repos for the same short name.
 */
export const EMBED_REPO: Record<string, string> = {
  'multilingual-e5-small': 'Xenova/multilingual-e5-small',
  'bge-m3': 'Xenova/bge-m3',
};

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  /** true after warmup; when cold, search degrades to lexical. */
  isWarm(): boolean;
  warmup(): Promise<void>;
  embedQueries(texts: string[]): Promise<Float32Array[]>;
  embedPassages(texts: string[]): Promise<Float32Array[]>;
  close(): Promise<void>;
}
