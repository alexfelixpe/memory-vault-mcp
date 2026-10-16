import type { Origin } from '../core/provenance.js';

/**
 * canPromote(): the ONLY gate into the curated layer (section 10 of the plan).
 * third_party_derived NEVER graduates on its own — the function never even
 * reads the acceptance rate. Locked in code, not in config; promote.test.ts
 * pins this.
 */

const NEVER_ELIGIBLE_CLASSES = new Set(['project_decision', 'hard_constraint', 'person_fact']);
const ELIGIBLE_CLASSES = new Set(['style_preference', 'flow_convention', 'env_gotcha']);

export interface PromoteInput {
  origin: Origin;
  itemClass: string;
  accepted?: number | undefined;
  total?: number | undefined;
  recentRejections?: number | undefined;
}

export type PromoteDecision =
  | { allowed: true }
  | { allowed: false; reason: 'needs_approval'; permanent: boolean };

/** Wilson lower bound at 90%. */
export function wilsonLowerBound(accepted: number, total: number, z = 1.6449): number {
  if (total === 0) return 0;
  const p = accepted / total;
  const z2 = z * z;
  return (p + z2 / (2 * total) - z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / (1 + z2 / total);
}

export function canPromote(input: PromoteInput): PromoteDecision {
  // Third-party provenance: human approval is PERMANENT, never looks at rates.
  if (input.origin === 'third_party_derived') {
    return { allowed: false, reason: 'needs_approval', permanent: true };
  }
  if (NEVER_ELIGIBLE_CLASSES.has(input.itemClass) || !ELIGIBLE_CLASSES.has(input.itemClass)) {
    return { allowed: false, reason: 'needs_approval', permanent: false };
  }
  const accepted = input.accepted ?? 0;
  const total = input.total ?? 0;
  if (total >= 20 && wilsonLowerBound(accepted, total) >= 0.85 && (input.recentRejections ?? 0) === 0) {
    return { allowed: true };
  }
  return { allowed: false, reason: 'needs_approval', permanent: false };
}
