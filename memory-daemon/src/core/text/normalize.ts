/**
 * normalizeForMatch(): aggressive normalization used ONLY to compare
 * substrings (match resolution in memory_replace/remove and lexical dedupe).
 * Never to hash nor to write back (section 7 of the plan).
 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .toLowerCase()
    .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/gm, '')   // bullet marker and checkbox
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1') // wikilink [[target|alias]] becomes target
    .replace(/(\*\*|__|\*|_|~~|==)/g, '')           // emphasis and highlight
    .replace(/[‘’‛]/g, "'")          // curly single quotes
    .replace(/[“”‟]/g, '"')          // curly double quotes
    .replace(/ /g, ' ')                        // NBSP
    .replace(/[ \t]+/g, ' ')
    .trim();
}
