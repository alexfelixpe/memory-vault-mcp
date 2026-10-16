import crypto from 'node:crypto';
import type { Embedder } from '../../src/embed/embedder.js';

/**
 * Deterministic embedder without ONNX: each token maps to a bucket by hash and
 * the vector is the normalized sum of the buckets. Texts that share words end
 * up close; with no word in common, cosine ~0. Enough to test fusion,
 * threshold, and degradation without loading a model.
 */
export class FakeEmbedder implements Embedder {
  readonly model = 'fake-hash-embedder';
  readonly dim = 64;
  private warm = false;

  isWarm(): boolean { return this.warm; }

  warmup(): Promise<void> {
    this.warm = true;
    return Promise.resolve();
  }

  private embedOne(text: string): Float32Array {
    const vec = new Float32Array(this.dim);
    const tokens = text.toLowerCase().normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const token of tokens) {
      const h = crypto.createHash('sha1').update(token).digest();
      vec[h[0]! % this.dim] = (vec[h[0]! % this.dim] ?? 0) + 1;
      vec[h[1]! % this.dim] = (vec[h[1]! % this.dim] ?? 0) + 0.5;
    }
    let norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm === 0) norm = 1;
    return vec.map((v) => v / norm) as Float32Array;
  }

  embedQueries(texts: string[]): Promise<Float32Array[]> {
    return Promise.resolve(texts.map((t) => this.embedOne(t)));
  }

  embedPassages(texts: string[]): Promise<Float32Array[]> {
    return Promise.resolve(texts.map((t) => this.embedOne(t)));
  }

  close(): Promise<void> {
    this.warm = false;
    return Promise.resolve();
  }
}
