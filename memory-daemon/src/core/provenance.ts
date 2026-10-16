import crypto from 'node:crypto';

/**
 * Per-bullet provenance (sections 6 and 10 of the plan). Single comment
 * format: <!-- mem id=<ULID> src:<human|sess|3p> -->. A missing marker in
 * an untrusted file = third_party_derived: absence never means trust.
 */

export type Origin = 'human_direct' | 'session_extract' | 'third_party_derived';

const SRC_TO_ORIGIN: Record<string, Origin> = {
  human: 'human_direct',
  sess: 'session_extract',
  '3p': 'third_party_derived',
};
export const ORIGIN_TO_SRC: Record<Origin, string> = {
  human_direct: 'human',
  session_extract: 'sess',
  third_party_derived: '3p',
};

// Relative strength: a merge ALWAYS inherits the weaker origin (mergeOrigin),
// otherwise consolidation becomes provenance laundering.
const STRENGTH: Record<Origin, number> = {
  human_direct: 2,
  session_extract: 1,
  third_party_derived: 0,
};

export function mergeOrigin(a: Origin, b: Origin): Origin {
  return STRENGTH[a] <= STRENGTH[b] ? a : b;
}

const BULLET_SRC_RE = /<!--\s*mem\s+id=([0-9A-HJKMNP-TV-Z]{26})\s+src:(human|sess|3p)\b[^>]*-->/;

export interface BulletProvenance {
  id: string;
  origin: Origin;
}

/** Reads a bullet's marker; undefined when absent or malformed. */
export function parseBulletSrc(bulletText: string): BulletProvenance | undefined {
  const m = BULLET_SRC_RE.exec(bulletText);
  if (!m) return undefined;
  return { id: m[1]!, origin: SRC_TO_ORIGIN[m[2]!]! };
}

export function memComment(id: string, origin: Origin): string {
  return `<!-- mem id=${id} src:${ORIGIN_TO_SRC[origin]} -->`;
}

// ULID: 48 bits of timestamp + 80 of randomness, Crockford base32.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now = Date.now()): string {
  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = B32[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  let rand = '';
  const bytes = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) rand += B32[bytes[i]! % 32];
  return ts + rand;
}
