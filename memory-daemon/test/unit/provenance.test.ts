import { describe, it, expect } from 'vitest';
import { parseBulletSrc, memComment, mergeOrigin, ulid } from '../../src/core/provenance.js';
import { canPromote } from '../../src/daemon/promote.js';

describe('provenance', () => {
  it('parseBulletSrc reads the comment that memComment writes', () => {
    const id = ulid();
    const parsed = parseBulletSrc(`- fact ${memComment(id, 'session_extract')}`);
    expect(parsed).toEqual({ id, origin: 'session_extract' });
  });

  it('a bullet without a marker returns undefined (absence is never trust)', () => {
    expect(parseBulletSrc('- fact without marker')).toBeUndefined();
  });

  it('mergeOrigin ALWAYS inherits the weakest', () => {
    expect(mergeOrigin('human_direct', 'third_party_derived')).toBe('third_party_derived');
    expect(mergeOrigin('session_extract', 'human_direct')).toBe('session_extract');
  });

  it('ulid has 26 Crockford chars and orders by time', () => {
    const a = ulid(1000);
    const b = ulid(2000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });
});

describe('canPromote (permanent third-party lock)', () => {
  it('third_party_derived needs approval even with 1000 accepts and a 1.0 rate', () => {
    const d = canPromote({ origin: 'third_party_derived', itemClass: 'style_preference', accepted: 1000, total: 1000 });
    expect(d).toEqual({ allowed: false, reason: 'needs_approval', permanent: true });
  });

  it('classes that are never eligible need approval even with a human origin', () => {
    for (const itemClass of ['project_decision', 'hard_constraint', 'person_fact']) {
      expect(canPromote({ origin: 'human_direct', itemClass, accepted: 100, total: 100 }).allowed).toBe(false);
    }
  });

  it('an eligible class graduates only with Wilson >= 0.85, n >= 20 and no recent rejection', () => {
    expect(canPromote({ origin: 'session_extract', itemClass: 'style_preference', accepted: 20, total: 20 }).allowed).toBe(true);
    expect(canPromote({ origin: 'session_extract', itemClass: 'style_preference', accepted: 19, total: 19 }).allowed).toBe(false);
    expect(canPromote({ origin: 'session_extract', itemClass: 'style_preference', accepted: 20, total: 20, recentRejections: 1 }).allowed).toBe(false);
    expect(canPromote({ origin: 'session_extract', itemClass: 'style_preference', accepted: 15, total: 20 }).allowed).toBe(false);
  });
});
