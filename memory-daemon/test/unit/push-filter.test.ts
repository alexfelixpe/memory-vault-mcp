import { describe, it, expect } from 'vitest';
import { isCuratedFileIntro } from '../../src/daemon/capture/push.js';
import type { SearchHit } from '../../src/index/search/search.js';

/**
 * The retrieval push must inject real memories only. The curated files open with
 * a descriptive header ("Who you are…", budget, edit rules) that is prose about
 * the file, not a memory. Every real curated entry lives under a '## Section', so
 * its heading is 'FILE > Section'; the intro chunk's heading is the bare file
 * title. This pins the exact rule that decides which hits are that intro.
 */

const hit = (over: Partial<SearchHit>): SearchHit => ({
  rank: 1, path_hint: 'global:USER.md', heading: 'USER', headingSlug: 'user',
  match: '', snippet: '', date: null, trust: 'curated', tier: 'curated', channels: ['lexical'], scores: {}, ...over,
});

describe('isCuratedFileIntro', () => {
  it('flags the bare-title intro chunk of a curated file', () => {
    expect(isCuratedFileIntro(hit({ path_hint: 'global:USER.md', heading: 'USER' }))).toBe(true);
    expect(isCuratedFileIntro(hit({ path_hint: 'global:MEMORY.md', heading: 'MEMORY' }))).toBe(true);
    expect(isCuratedFileIntro(hit({ path_hint: 'client:PROJECT.md', heading: 'PROJECT' }))).toBe(true);
    // A hit with no heading at all is also file-level prose, not an entry.
    expect(isCuratedFileIntro(hit({ path_hint: 'global:USER.md', heading: null }))).toBe(true);
  });

  it('keeps a real entry: any heading with a section (contains " > ")', () => {
    expect(isCuratedFileIntro(hit({ path_hint: 'global:USER.md', heading: 'USER > Perfil' }))).toBe(false);
    expect(isCuratedFileIntro(hit({ path_hint: 'global:MEMORY.md', heading: 'MEMORY > Decisoes <!-- auto -->' }))).toBe(false);
  });

  it('never touches non-curated files, even with a bare heading', () => {
    // Daily notes keep bullets directly under an H1 date: bare heading, but real.
    expect(isCuratedFileIntro(hit({ path_hint: 'global:daily/2026-07-27.md', heading: '2026-07-27' }))).toBe(false);
    expect(isCuratedFileIntro(hit({ path_hint: 'client:Meetings/Standup.md', heading: 'Standup' }))).toBe(false);
    // The archive files are not the live curated intro either.
    expect(isCuratedFileIntro(hit({ path_hint: 'global:USER-archive.md', heading: 'USER-archive' }))).toBe(false);
  });
});
