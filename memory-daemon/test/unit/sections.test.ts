import { describe, it, expect } from 'vitest';
import { parseSections, resolveEntry } from '../../src/core/markdown/sections.js';

const DOC = `loose preamble

## Preferences

- Prefers TypeScript
- Uses Windows 11
  with WSL sometimes

## Tools

- Prefers TypeScript
\`\`\`
## fake heading in fence
- fake bullet in fence
\`\`\`
`;

describe('parseSections', () => {
  it('splits the preamble and sections by ##', () => {
    const sections = parseSections(DOC);
    expect(sections.map((s) => s.name)).toEqual(['', 'Preferences', 'Tools']);
  });

  it('a bullet with an indented continuation line becomes a single entry', () => {
    const prefs = parseSections(DOC).find((s) => s.name === 'Preferences')!;
    expect(prefs.entries).toHaveLength(2);
    expect(prefs.entries[1]!.text).toBe('Uses Windows 11 with WSL sometimes');
  });

  it('a heading and a bullet inside a code fence do not count', () => {
    const sections = parseSections(DOC);
    expect(sections.some((s) => s.name.includes('fake'))).toBe(false);
    const tools = sections.find((s) => s.name === 'Tools')!;
    expect(tools.entries).toHaveLength(1);
  });
});

describe('resolveEntry', () => {
  it('a match in two sections is ambiguous, never picks the first (T2)', () => {
    const r = resolveEntry(parseSections(DOC), 'Prefers TypeScript');
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') expect(r.candidates).toHaveLength(2);
  });

  it('with a section scope it resolves to exactly one', () => {
    const r = resolveEntry(parseSections(DOC), 'Prefers TypeScript', 'Tools');
    expect(r.status).toBe('unique');
  });

  it('zero matches returns none', () => {
    expect(resolveEntry(parseSections(DOC), 'nonexistent').status).toBe('none');
  });

  it('a match with NBSP and different case still matches', () => {
    const r = resolveEntry(parseSections(DOC), 'uses windows 11');
    expect(r.status).toBe('unique');
  });
});
