import { describe, it, expect } from 'vitest';
import { measureCurated, stripComments, budgetInfo, BUDGETS } from '../../src/core/budget.js';

describe('measureCurated', () => {
  it('does not count frontmatter or <!-- mem --> comments', () => {
    const withExtras = `---\ntitle: x\n---\n# T\n\n- fact one <!-- mem id=01ARZ3NDEKTSV4RRFFQ69G5FA1 src:human -->\n`;
    const bare = `# T\n\n- fact one\n`;
    expect(measureCurated(withExtras)).toBe(measureCurated(bare));
  });

  it('counts code points, not bytes (an accent does not weigh double)', () => {
    // 'naive' and 'naïve' both have a length of 5 code points.
    expect(measureCurated('naïve\n')).toBe(measureCurated('naive\n'));
  });

  it('stripComments removes all HTML comments', () => {
    expect(stripComments('a <!-- x --> b <!-- mem id=1 -->')).toBe('a  b ');
  });

  it('budgetInfo applies the right ceiling per file', () => {
    expect(budgetInfo('x', 'user').limit_chars).toBe(BUDGETS['user']);
    expect(budgetInfo('x', 'memory').limit_chars).toBe(BUDGETS['memory']);
    expect(budgetInfo('x', 'project').limit_chars).toBe(BUDGETS['project']);
  });
});
