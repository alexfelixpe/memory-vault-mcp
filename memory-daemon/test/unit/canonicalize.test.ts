import { describe, it, expect } from 'vitest';
import { canonicalize } from '../../src/core/text/canonicalize.js';
import { contentHash } from '../../src/core/hash.js';

// Built by char code: 100% ASCII source, immune to unicode re-normalization
// by an editor or tooling (which would empty these tests).
const BOM = String.fromCharCode(0xfeff);
const A_TILDE_NFC = String.fromCharCode(0xe3);      // 'a' with precomposed tilde
const COMBINING_TILDE = String.fromCharCode(0x0303); // combining tilde

describe('canonicalize', () => {
  it('strips the BOM from the start', () => {
    expect(canonicalize(BOM + '# title\n')).toBe('# title\n');
  });

  it('converts CRLF and a lone CR to LF', () => {
    expect(canonicalize('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });

  it('normalizes a decomposed accent to NFC', () => {
    const decomposed = 'reunia' + COMBINING_TILDE + 'o\n';
    const precomposed = 'reuni' + A_TILDE_NFC + 'o\n';
    expect(decomposed).not.toBe(precomposed);
    expect(canonicalize(decomposed)).toBe(precomposed);
  });

  it('erases space and tab at end of line', () => {
    expect(canonicalize('a  \nb\t\n')).toBe('a\nb\n');
  });

  it('collapses 3+ line breaks into 2 and ensures exactly one final break', () => {
    expect(canonicalize('a\n\n\n\nb')).toBe('a\n\nb\n');
    expect(canonicalize('a\n\n\n')).toBe('a\n');
  });

  it('does not lowercase: different-case versions have a different hash (anti lost update)', () => {
    expect(contentHash('Prefers TypeScript\n')).not.toBe(contentHash('prefers typescript\n'));
  });

  it('the same content with CRLF+BOM and LF has the SAME hash', () => {
    const lf = '# note\n\n- bullet one\n';
    const windows = BOM + '# note\r\n\r\n- bullet one\r\n';
    expect(contentHash(windows)).toBe(contentHash(lf));
  });
});
