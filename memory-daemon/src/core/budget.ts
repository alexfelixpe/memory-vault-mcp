import { canonicalize } from './text/canonicalize.js';

/**
 * Budget of the curated layer (section 9 of the plan). Counts CODE POINTS
 * over the canonical text, without frontmatter and without <!-- --> comments:
 * the per-bullet comment is infrastructure, not memory, and cannot steal
 * budget.
 */

export const BUDGETS: Record<string, number> = {
  user: 1400,
  memory: 2200,
  project: 1500,
};

/** Removes HTML comments (including the per-bullet <!-- mem ... -->). */
export function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

/** Official measure: code points of the canonical body, without frontmatter/comments. */
export function measureCurated(raw: string): number {
  const body = stripComments(stripFrontmatter(canonicalize(raw)))
    .replace(/[ \t]+$/gm, '')   // removing the comment leaves dangling whitespace
    .replace(/[ \t]+/g, ' ');
  return [...body].length;
}

export interface BudgetInfo {
  used_chars: number;
  limit_chars: number;
  pct: number;
}

export function budgetInfo(raw: string, fileKind: string): BudgetInfo {
  const used = measureCurated(raw);
  const limit = BUDGETS[fileKind] ?? BUDGETS['project']!;
  return { used_chars: used, limit_chars: limit, pct: Math.round((100 * used) / limit) };
}
