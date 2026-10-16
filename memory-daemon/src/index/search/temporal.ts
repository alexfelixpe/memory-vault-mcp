/**
 * Temporal signal: freshness with a 180-day half-life (SEARCH_DEFAULTS).
 * An evergreen file (curated, marked notes) is exempt from decay.
 */

export interface FreshnessInput {
  docDate: string | null;
  /** Fallback when the note has no date of its own. */
  mtimeMs: number;
  isEvergreen: boolean;
}

export function freshness(input: FreshnessInput, halfLifeDays: number, now: number): number {
  if (input.isEvergreen) return 1.0;
  const parsed = input.docDate ? Date.parse(input.docDate) : Number.NaN;
  const ref = Number.isNaN(parsed) ? input.mtimeMs : parsed;
  const days = Math.max(0, (now - ref) / 86_400_000);
  return Math.pow(0.5, days / halfLifeDays);
}
