/**
 * Prompt injection scan. Versioned rules: when SCANNER_VERSION goes up, the
 * reconcile reindexes files marked with a lower version. On READ nothing is
 * removed: a flag only forces the chunk into the envelope. In Increment 4,
 * only inj.persist and inj.exfil block a write into the curated layer.
 *
 * SCANNER_VERSION is the shared "index scan version": it also gates the
 * index-time secret redaction (finding #4). Bumped 1 -> 2 so files indexed
 * before that redaction existed are reprocessed once and any stored secret is
 * masked.
 */

// 3: not a rule change — forces the re-index that backfills the chunk `tier`
// column added by schema migration 003.
// 4: tier heading match widened to CONTAINS 'transcript' (bold Gemini-style
// headings in older synced notes escaped the exact match).
export const SCANNER_VERSION = 4;

interface Rule {
  id: string;
  re: RegExp;
}

// Few rules, high precision. A false positive here refuses a legitimate
// memory (critique A9); scan-corpus.ts measures firings before any tightening.
//
// Bilingual by design: each rule lists English AND Portuguese attack tokens
// (e.g. save|salve|grave, rule|regra, always|sempre). The non-English tokens
// are detection DATA, not project prose — they catch injection attempts
// written in Portuguese, because a vault may hold Portuguese content. Do not
// remove them to make the file "English only"; that blinds the scanner to
// Portuguese-language attacks. Add tokens for new languages the same way.
const RULES: Rule[] = [
  {
    id: 'inj.persist',
    re: /\b(remember|memorize|save|store|salve|grave|lembre(-se)?)\b.{0,60}\b(instruction|instru[cç][aã]o|rule|regra|always|sempre|permanent)/i,
  },
  {
    id: 'inj.exfil',
    re: /\b(send|post|upload|envie|exfiltr\w*|mande|transmita)\b.{0,60}\b(https?:\/\/|webhook|api[_ ]?key|token|secret|senha|credencia)/i,
  },
  {
    id: 'inj.override',
    re: /\b(ignore|disregard|esque[cç]a|desconsidere)\b.{0,40}\b(previous|above|all|anteriores|acima|todas?)\b.{0,20}\b(instruction|instru[cç]|rule|regra|prompt)/i,
  },
  {
    id: 'inj.role',
    re: /<\|im_start\|>|\[INST\]|<system>|<\/system>|---8<---/i,
  },
];

/** NFKC plus removal of zero-width and bidi: injection loves invisible unicode. */
export function normalizeForScan(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[​-‏‪-‮⁠-⁤﻿]/g, '');
}

/** Returns the ids of the rules that fired (empty = clean). */
export function scanInjection(text: string): string[] {
  const clean = normalizeForScan(text.replace(/\r\n?/g, '\n'));
  const flags: string[] = [];
  for (const rule of RULES) {
    if (rule.re.test(clean)) flags.push(rule.id);
  }
  return flags;
}
