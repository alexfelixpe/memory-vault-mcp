import { describe, it, expect } from 'vitest';
import { detectEol, applyEol, stripBom } from '../../src/core/text/eol.js';

describe('eol', () => {
  it('detects the dominant EOL; a tie becomes lf', () => {
    expect(detectEol('a\r\nb\r\nc\n')).toBe('crlf');
    expect(detectEol('a\nb\nc\r\n')).toBe('lf');
    expect(detectEol('no break')).toBe('lf');
  });

  it('applyEol is idempotent and reversible', () => {
    const lf = 'a\nb\n';
    expect(applyEol(applyEol(lf, 'crlf'), 'lf')).toBe(lf);
    expect(applyEol('a\r\nb\n', 'crlf')).toBe('a\r\nb\r\n');
  });

  it('stripBom removes only the leading BOM', () => {
    expect(stripBom('﻿abc')).toBe('abc');
    expect(stripBom('abc﻿')).toBe('abc﻿');
  });
});
