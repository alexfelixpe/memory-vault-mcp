import { describe, it, expect } from 'vitest';
import { normalizeForMatch } from '../../src/core/text/normalize.js';

describe('normalizeForMatch', () => {
  it('is case-insensitive and strips the bullet marker', () => {
    expect(normalizeForMatch('- Prefers TypeScript')).toBe('prefers typescript');
    expect(normalizeForMatch('* [x] Prefers TypeScript')).toBe('prefers typescript');
  });

  it('resolves the wikilink to its target and strips emphasis', () => {
    expect(normalizeForMatch('uses [[Postgres|the database]] with **schema** _separate_')).toBe(
      'uses postgres with schema separate',
    );
  });

  it('normalizes curly quotes, NBSP and double space', () => {
    expect(normalizeForMatch('“Isolation” of  ‘tenant’')).toBe(`"isolation" of 'tenant'`);
  });

  it('matches a stored bullet with CRLF, double space and NBSP against the clean string (T2)', () => {
    const dirty = '- Prefers TypeScript  in\r\nall projects';
    expect(normalizeForMatch(dirty)).toContain(normalizeForMatch('prefers typescript'));
  });
});
