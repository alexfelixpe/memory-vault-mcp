/**
 * End-of-line detection and application. The vault is edited by a human on
 * Windows (CRLF possible) and by the daemon (canonical LF); whoever writes
 * back preserves the file's dominant style.
 */

export type Eol = 'lf' | 'crlf';

/** Detects the text's dominant EOL; a tie or text with no line break becomes 'lf'. */
export function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? 'crlf' : 'lf';
}

/** Removes the leading UTF-8 BOM (Notepad and PowerShell 5.1 insert it). */
export function stripBom(text: string): string {
  return text.replace(/^﻿/, '');
}

/** Applies the requested EOL over text already normalized to LF. */
export function applyEol(text: string, eol: Eol): string {
  const lf = text.replace(/\r\n?/g, '\n');
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}
