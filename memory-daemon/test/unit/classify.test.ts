import { describe, it, expect } from 'vitest';
import { classifyFile, trustFromOrigin } from '../../src/index/indexer.js';

describe('classifyFile', () => {
  it('USER.md and MEMORY.md at the root are curated, human origin, evergreen', () => {
    const c = classifyFile('USER.md', {});
    expect(c).toMatchObject({ layer: 'curated', origin: 'human_direct', trust: 'curated', isEvergreen: true });
  });

  it('Meetings/ is raw and third_party_derived by default (absence is never trust)', () => {
    const c = classifyFile('Meetings/2026-07-10 - Weekly.md', {});
    expect(c).toMatchObject({ layer: 'raw', docType: 'meeting', origin: 'third_party_derived', trust: 'untrusted' });
    expect(c.docDate).toBe('2026-07-10');
  });

  it('the path is compared in lowercase (NTFS)', () => {
    expect(classifyFile('MEETINGS/nota.md', {}).docType).toBe('meeting');
  });

  it('frontmatter overrides origin and status', () => {
    const c = classifyFile('Topics/X.md', { origin: 'human_direct', status: 'obsolete' });
    expect(c.origin).toBe('human_direct');
    expect(c.trust).toBe('curated');
    expect(c.status).toBe('obsolete');
  });

  it('the frontmatter date wins over the file-name date', () => {
    const c = classifyFile('Meetings/2026-01-01 - X.md', { date: '2026-07-10' });
    expect(c.docDate).toBe('2026-07-10');
  });

  it('trust ALWAYS derives from origin (a single concept)', () => {
    expect(trustFromOrigin('human_direct')).toBe('curated');
    expect(trustFromOrigin('session_extract')).toBe('session');
    expect(trustFromOrigin('third_party_derived')).toBe('untrusted');
  });
});
