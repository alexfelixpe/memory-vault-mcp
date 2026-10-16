import type Database from 'better-sqlite3';
import type { Scope } from './lexical.js';

/**
 * Vector channel: brute force over a contiguous Float32Array in memory.
 * Up to ~50 thousand chunks the scan costs less than embedding the query.
 * The interface exists so swapping to sqlite-vec/int8 is a one-class change.
 */

export interface VectorHit {
  chunkId: number;
  cosine: number;
}

export interface VectorIndex {
  readonly size: number;
  /** Reloads the matrix from SQLite (after an embedding backlog or reconcile). */
  reload(): void;
  /**
   * `vaults` (vault read isolation) limits the scan; undefined scans everything.
   * `scope` limits it the same way and for the same reason: see reload().
   */
  search(query: Float32Array, k: number, minCosine: number, vaults?: readonly string[] | undefined, scope?: Scope): VectorHit[];
}

export class BruteForceVectorIndex implements VectorIndex {
  private ids: number[] = [];
  /** Vault of each row, in the same order as ids: the scan's isolation filter. */
  private vaults: string[] = [];
  /** Layer and doc type of each row: the scan's scope filter, same idea as vault. */
  private layers: string[] = [];
  private docTypes: Array<string | null> = [];
  private matrix = new Float32Array(0);

  constructor(
    private readonly db: Database.Database,
    private readonly model: string,
    private readonly dim: number,
  ) {}

  get size(): number {
    return this.ids.length;
  }

  reload(): void {
    // The vault travels with each row so the scan itself can be scoped. Without
    // it, filtering afterwards would let another vault's vectors take the k best
    // slots and leave a scoped search with fewer results than it should have.
    //
    // The layer and the doc type travel for exactly the same reason. Measured on
    // a real vault of 16290 chunks: a Portuguese query under `--scope meetings`
    // got zero vector results, because all 50 slots went to session transcripts,
    // which are Portuguese too, and the scope filter then dropped every one of
    // them. The search silently fell back to keyword plus recency.
    //
    // Rows stream into a preallocated matrix instead of being loaded with .all():
    // that call held every vector as a Buffer at once, and the memory stayed
    // resident after the reload. The chunk count is a strict upper bound for the
    // joined rows, because embeddings is keyed by (chunk_hash, model) and each
    // joined row is therefore a distinct chunk.
    // When many chunks have no vector, the result is copied so the slack is freed.
    const { n: cap } = this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
    const stmt = this.db.prepare(`
      SELECT c.id, f.vault, f.layer, f.doc_type, e.vec
      FROM embeddings e
      JOIN chunks c ON c.chunk_hash = e.chunk_hash
      JOIN files f ON f.id = c.file_id
      WHERE e.model = ? AND f.is_deleted = 0 AND f.quarantined = 0
    `).raw();

    const ids: number[] = [];
    const vaults: string[] = [];
    const layers: string[] = [];
    const docTypes: Array<string | null> = [];
    const matrix = new Float32Array(cap * this.dim);
    let n = 0;
    for (const row of stmt.iterate(this.model) as IterableIterator<[number, string, string, string | null, Buffer]>) {
      if (n >= cap) break; // cannot happen, but never write past the matrix
      const vec = row[4];
      if (vec.byteLength !== this.dim * 4) continue; // dim from another model
      ids.push(row[0]);
      vaults.push(row[1]);
      layers.push(row[2]);
      docTypes.push(row[3]);
      matrix.set(new Float32Array(vec.buffer, vec.byteOffset, this.dim), n * this.dim);
      n++;
    }
    // Assigned only now, so an exception above leaves the previous index intact.
    this.ids = ids;
    this.vaults = vaults;
    this.layers = layers;
    this.docTypes = docTypes;
    this.matrix = cap - n > cap / 8 ? matrix.slice(0, n * this.dim) : matrix.subarray(0, n * this.dim);
  }

  /** Same test as search.ts inScope, applied to the row arrays instead of hydrated metadata. */
  private rowInScope(i: number, scope: Scope): boolean {
    switch (scope) {
      case 'all': return true;
      case 'curated': return this.layers[i] === 'curated';
      case 'reservoir': return this.layers[i] === 'reservoir';
      case 'meetings': return this.docTypes[i] === 'meeting';
      case 'daily': return this.docTypes[i] === 'daily';
    }
  }

  search(query: Float32Array, k: number, minCosine: number, vaults?: readonly string[] | undefined, scope?: Scope): VectorHit[] {
    const hits: VectorHit[] = [];
    const { ids, matrix, dim } = { ids: this.ids, matrix: this.matrix, dim: this.dim };
    for (let i = 0; i < ids.length; i++) {
      // Skip an unreadable row before the dot product: cheaper, and it keeps the
      // k best slots for chunks this caller may actually see.
      if (vaults !== undefined && !vaults.includes(this.vaults[i]!)) continue;
      if (scope !== undefined && !this.rowInScope(i, scope)) continue;
      let dot = 0;
      const base = i * dim;
      for (let j = 0; j < dim; j++) dot += matrix[base + j]! * query[j]!;
      if (dot >= minCosine) hits.push({ chunkId: ids[i]!, cosine: dot });
    }
    hits.sort((a, b) => b.cosine - a.cosine);
    return hits.slice(0, k);
  }
}
