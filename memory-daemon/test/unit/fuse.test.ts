import { describe, it, expect } from 'vitest';
import {
  rrf, minMaxNormalize, dedupeOverlapping, capPerFile, mergeBypassFirst, type FusedHit,
} from '../../src/index/search/fuse.js';

describe('rrf', () => {
  it('sums weight/(k+position+1) per list and orders by score', () => {
    const fused = rrf([
      { list: [1, 2], weight: 1.0, channel: 'lexical' },
      { list: [2, 1], weight: 1.0, channel: 'recency' },
    ], 60);
    // Both appear in the two lists at mirrored positions: equal scores.
    expect(fused).toHaveLength(2);
    expect(fused[0]!.score).toBeCloseTo(fused[1]!.score, 10);
    expect(fused[0]!.channels.sort()).toEqual(['lexical', 'recency']);
  });

  it('an item in only one channel loses to one that appears in two', () => {
    const fused = rrf([
      { list: [1, 2], weight: 1.0, channel: 'a' },
      { list: [2], weight: 1.0, channel: 'b' },
    ], 60);
    expect(fused[0]!.chunkId).toBe(2);
  });

  it('uses the POSITION in the list, not the channel raw score', () => {
    // 1/(60+1) for position 0 regardless of how high the bm25 was.
    const fused = rrf([{ list: [7], weight: 2.0, channel: 'a' }], 60);
    expect(fused[0]!.score).toBeCloseTo(2.0 / 61, 10);
  });
});

describe('minMaxNormalize', () => {
  it('normalizes to [0,1] within the pool', () => {
    expect(minMaxNormalize([10, 20, 30])).toEqual([0, 0.5, 1]);
  });
  it('a constant pool (or a single item) becomes 1.0', () => {
    expect(minMaxNormalize([5, 5])).toEqual([1, 1]);
    expect(minMaxNormalize([42])).toEqual([1]);
  });
});

const hit = (chunkId: number, score = 1): FusedHit => ({ chunkId, score, channels: ['lexical'] });

describe('dedupeOverlapping', () => {
  const meta = new Map([
    [1, { fileId: 10, charStart: 0, charEnd: 100 }],
    [2, { fileId: 10, charStart: 40, charEnd: 140 }],   // 60% overlap with 1
    [3, { fileId: 10, charStart: 500, charEnd: 600 }],  // no overlap
    [4, { fileId: 99, charStart: 0, charEnd: 100 }],    // another file
  ]);
  it('discards an overlapping chunk from the same file, keeps the higher score', () => {
    const kept = dedupeOverlapping([hit(1, 2), hit(2, 1), hit(3), hit(4)], (id) => meta.get(id)!, 0.5);
    expect(kept.map((h) => h.chunkId)).toEqual([1, 3, 4]);
  });
});

describe('capPerFile', () => {
  it('at most N per file, preserving the order', () => {
    const files = new Map([[1, 10], [2, 10], [3, 10], [4, 20]]);
    const kept = capPerFile([hit(1), hit(2), hit(3), hit(4)], (id) => files.get(id)!, 2);
    expect(kept.map((h) => h.chunkId)).toEqual([1, 2, 4]);
  });
});

describe('mergeBypassFirst', () => {
  it('bypass goes first and does not duplicate an already ranked item', () => {
    const merged = mergeBypassFirst([hit(5)], [hit(1), hit(5), hit(2)], 3);
    expect(merged.map((h) => h.chunkId)).toEqual([5, 1, 2]);
  });
});
