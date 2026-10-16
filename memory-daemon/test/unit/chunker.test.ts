import { describe, it, expect } from 'vitest';
import { chunkNote, CHUNK_TARGET_TOKENS } from '../../src/core/markdown/chunker.js';

function chunk(body: string, overrides: Partial<Parameters<typeof chunkNote>[0]> = {}) {
  return chunkNote({ fileLabel: 'note', docDate: '2026-07-10', body, baseOffset: 0, baseLine: 0, ...overrides });
}

describe('chunkNote', () => {
  it('builds the contextual prefix file | date | section', () => {
    const [c] = chunk('## Decisions\n\nDecision text.\n');
    expect(c!.contextPrefix).toBe('note | 2026-07-10 | Decisions');
  });

  it('without a date the prefix skips the middle part', () => {
    const [c] = chunk('## Decisions\n\nText.\n', { docDate: null });
    expect(c!.contextPrefix).toBe('note | Decisions');
  });

  it('a transcript turn becomes kind turn with the speaker in the prefix', () => {
    const chunks = chunk('## Decisions\n\nBob: We closed the isolation by schema.\n');
    const turn = chunks.find((c) => c.kind === 'turn');
    expect(turn).toBeDefined();
    expect(turn!.speaker).toBe('Bob');
    expect(turn!.contextPrefix).toContain('Bob');
  });

  it('does not cross a heading boundary', () => {
    const chunks = chunk('## A\n\ntext of a\n\n## B\n\ntext of b\n');
    const bodies = chunks.map((c) => c.body);
    expect(bodies.some((b) => b.includes('text of a') && b.includes('text of b'))).toBe(false);
  });

  it('a long section splits into chunks with overlap', () => {
    const paragraphs = Array.from({ length: 60 }, (_, i) =>
      `Paragraph ${i} with a handful of reasonably long words to add up enough tokens.`,
    ).join('\n\n');
    const chunks = chunk(`## Long\n\n${paragraphs}\n`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(CHUNK_TARGET_TOKENS * 1.6);
    // Overlap: the next chunk starts before the previous one ends.
    expect(chunks[1]!.charStart).toBeLessThan(chunks[0]!.charEnd);
  });

  it('offsets and line account for the frontmatter (baseOffset/baseLine)', () => {
    const [c] = chunk('## X\n\nbody\n', { baseOffset: 100, baseLine: 4 });
    expect(c!.charStart).toBeGreaterThanOrEqual(100);
    expect(c!.startLine).toBeGreaterThan(4);
  });

  it('anchor is the first useful line of the chunk, cut to 120 chars', () => {
    const [c] = chunk('## S\n\n- very short anchor bullet\n');
    expect(c!.anchorSubstring).toContain('anchor bullet');
    expect(c!.anchorSubstring.length).toBeLessThanOrEqual(120);
  });
});
