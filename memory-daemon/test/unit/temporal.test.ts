import { describe, it, expect } from 'vitest';
import { freshness } from '../../src/index/search/temporal.js';

const NOW = Date.parse('2026-07-21T00:00:00Z');
const DAY = 86_400_000;

describe('freshness', () => {
  it('evergreen is always 1.0, even when old', () => {
    expect(freshness({ docDate: '2020-01-01', mtimeMs: 0, isEvergreen: true }, 180, NOW)).toBe(1.0);
  });

  it('half-life: 180 days ago is worth 0.5, today is worth 1.0', () => {
    const halfAgo = new Date(NOW - 180 * DAY).toISOString().slice(0, 10);
    expect(freshness({ docDate: halfAgo, mtimeMs: 0, isEvergreen: false }, 180, NOW)).toBeCloseTo(0.5, 2);
    expect(freshness({ docDate: '2026-07-21', mtimeMs: 0, isEvergreen: false }, 180, NOW)).toBeCloseTo(1.0, 2);
  });

  it('without doc_date it falls back to mtime', () => {
    const f = freshness({ docDate: null, mtimeMs: NOW - 360 * DAY, isEvergreen: false }, 180, NOW);
    expect(f).toBeCloseTo(0.25, 2);
  });

  it('a future date (skewed clock) does not exceed 1.0', () => {
    expect(freshness({ docDate: '2030-01-01', mtimeMs: 0, isEvergreen: false }, 180, NOW)).toBe(1.0);
  });
});
