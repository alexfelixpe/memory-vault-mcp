/**
 * canonicalize() is the single base of every hash in the system (section 7
 * of the plan). Disk bytes are never hashed directly: CRLF, BOM and
 * decomposed accents would make the same content produce different hashes
 * across editors.
 * No lowercase: a lowercased hash would make two distinct versions collide
 * and allow a lost update (review point D1).
 */
export function canonicalize(raw: string): string {
  return raw
    .replace(/^﻿/, '')       // BOM from Notepad and PowerShell 5.1
    .replace(/\r\n?/g, '\n')      // CRLF and lone CR to LF
    .normalize('NFC')             // decomposed vs precomposed accents (Portuguese)
    .replace(/[ \t]+$/gm, '')     // trailing whitespace at end of line
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n*$/, '\n');
}
