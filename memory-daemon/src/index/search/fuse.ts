/**
 * Channel fusion: RRF (k=60) over the POSITION of each hit within its list,
 * never over the raw score (the scales are not comparable). The identifier
 * bypass enters OUTSIDE the fusion, guaranteed in the first positions.
 */

export interface FusedHit {
  chunkId: number;
  score: number;
  channels: string[];
}

export interface ChannelList {
  /** chunkIds in the channel's relevance order. */
  list: number[];
  weight: number;
  channel: string;
}

export function rrf(lists: ChannelList[], k: number): FusedHit[] {
  const acc = new Map<number, { score: number; channels: Set<string> }>();
  for (const { list, weight, channel } of lists) {
    list.forEach((chunkId, position) => {
      const entry = acc.get(chunkId) ?? { score: 0, channels: new Set<string>() };
      entry.score += weight / (k + position + 1);
      entry.channels.add(channel);
      acc.set(chunkId, entry);
    });
  }
  return [...acc.entries()]
    .map(([chunkId, e]) => ({ chunkId, score: e.score, channels: [...e.channels] }))
    .sort((a, b) => b.score - a.score);
}

/** Min-max normalization of scores within the pool; a pool of one becomes 1.0. */
export function minMaxNormalize(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max === min) return scores.map(() => 1.0);
  return scores.map((s) => (s - min) / (max - min));
}

export interface OverlapMeta {
  fileId: number;
  charStart: number;
  charEnd: number;
}

/**
 * Chunks from the same file whose ranges overlap above the threshold are
 * overlap duplicates from the chunker: keep the one with the higher score.
 */
export function dedupeOverlapping(
  hits: FusedHit[],
  meta: (chunkId: number) => OverlapMeta,
  ratio: number,
): FusedHit[] {
  const kept: FusedHit[] = [];
  for (const hit of hits) {
    const m = meta(hit.chunkId);
    const dup = kept.some((k) => {
      const km = meta(k.chunkId);
      if (km.fileId !== m.fileId) return false;
      const overlap = Math.min(km.charEnd, m.charEnd) - Math.max(km.charStart, m.charStart);
      if (overlap <= 0) return false;
      const shorter = Math.min(km.charEnd - km.charStart, m.charEnd - m.charStart);
      return shorter > 0 && overlap / shorter > ratio;
    });
    if (!dup) kept.push(hit);
  }
  return kept;
}

/** Diversity cap: at most N chunks per file (default 2 in the top-6). */
export function capPerFile(hits: FusedHit[], fileOf: (chunkId: number) => number, max: number): FusedHit[] {
  const counts = new Map<number, number>();
  const kept: FusedHit[] = [];
  for (const hit of hits) {
    const file = fileOf(hit.chunkId);
    const n = counts.get(file) ?? 0;
    if (n < max) {
      counts.set(file, n + 1);
      kept.push(hit);
    }
  }
  return kept;
}

/** Bypass first, without duplicating what is already ranked; cuts at topN. */
export function mergeBypassFirst(bypass: FusedHit[], ranked: FusedHit[], topN: number): FusedHit[] {
  const seen = new Set(bypass.map((h) => h.chunkId));
  const merged = [...bypass];
  for (const hit of ranked) {
    if (!seen.has(hit.chunkId)) {
      merged.push(hit);
      seen.add(hit.chunkId);
    }
  }
  return merged.slice(0, topN);
}
