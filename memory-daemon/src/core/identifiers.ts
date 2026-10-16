import fs from 'node:fs';
import path from 'node:path';

/**
 * Identifier extraction for the index's 'identifiers' column and for the
 * exact-search bypass. Identifiers are stored in UPPERCASE, separated by
 * spaces (section 6 of the plan).
 */

// Ticket key: PROJ-123, ABC-1234. Prefix 2..8 chars starting with a letter.
const TICKET_RE = /\b([A-Z][A-Z0-9]{1,7})-(\d{1,6})\b/g;

// In a query the user types "PROJ 123"; canonicalize to PROJ-123 (test T3).
const TICKET_LOOSE_RE = /\b([A-Z][A-Z0-9]{1,7})[ -](\d{1,6})\b/g;

// Git SHA, 7 to 40 hex. Requires at least one letter so it does not swallow pure numbers.
const SHA_RE = /\b(?=[0-9a-f]{7,40}\b)[0-9a-f]*[a-f][0-9a-f]*\b/g;

/** Controlled vocabulary loaded from a vault's _registry.md. */
export type Vocabulary = ReadonlySet<string>;

/**
 * First column of every markdown table in the text. A registry kept as a table
 * (canonical name | aliases) carries its names in plain cells, which the
 * wikilink/code/bold patterns cannot see. The row right before a `|---|`
 * separator is the header, so it never becomes vocabulary.
 */
function tableFirstColumn(raw: string): string[] {
  const terms: string[] = [];
  // A row is only kept once the NEXT line proves it is not a header: the
  // header is recognizable solely by the separator that follows it.
  let pending: string | undefined;
  const flush = (): void => {
    if (pending !== undefined) terms.push(pending);
    pending = undefined;
  };
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) { flush(); continue; }
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) { pending = undefined; continue; }
    flush();
    pending = cells[0] ?? '';
  }
  flush();
  return terms;
}

/** Where a vault may keep its registry, relative to the vault root. */
const REGISTRY_LOCATIONS = ['_registry.md', 'Topics/_registry.md'];

/**
 * Reads the vault's registry and collects controlled names: wikilinks, code
 * spans, bold terms, and the first column of tables. The file may live at the
 * vault root or in Topics/ — an Obsidian vault keeps it next to the topic
 * notes it governs. A missing registry becomes empty vocabulary.
 */
export function loadRegistryVocab(vaultRoot: string): Vocabulary {
  const vocab = new Set<string>();
  const add = (t: string | undefined): void => {
    const term = (t ?? '').trim();
    if (term.length >= 3) vocab.add(term.toUpperCase());
  };
  for (const rel of REGISTRY_LOCATIONS) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(vaultRoot, rel), 'utf8');
    } catch {
      continue;
    }
    const patterns = [
      /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g, // [[Name]] and [[Name|alias]]
      /`([^`\n]{3,60})`/g,                  // `term`
      /\*\*([^*\n]{3,60})\*\*/g,            // **term**
    ];
    for (const re of patterns) {
      for (const m of raw.matchAll(re)) add(m[1]);
    }
    for (const term of tableFirstColumn(raw)) add(term);
  }
  return vocab;
}

/**
 * Extracts identifiers from a chunk's text: tickets, SHAs and vocabulary
 * terms. Returns a unique list, in UPPERCASE, in order of appearance.
 */
export function extractIdentifiers(text: string, vocab?: Vocabulary): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(TICKET_RE)) found.add(`${m[1]}-${m[2]}`.toUpperCase());
  for (const m of text.matchAll(SHA_RE)) found.add(m[0].toUpperCase());
  if (vocab && vocab.size > 0) {
    const upper = text.toUpperCase();
    for (const term of vocab) {
      // Manual boundary: a non-alphanumeric character on both sides.
      let idx = upper.indexOf(term);
      while (idx !== -1) {
        const before = idx === 0 ? '' : upper[idx - 1]!;
        const after = idx + term.length >= upper.length ? '' : upper[idx + term.length]!;
        if (!/[A-Z0-9]/.test(before) && !/[A-Z0-9]/.test(after)) {
          found.add(term);
          break;
        }
        idx = upper.indexOf(term, idx + 1);
      }
    }
  }
  return [...found];
}

/**
 * Extracts identifiers from a QUERY, accepting the loose form with a
 * space ("PROJ 123" becomes PROJ-123) in addition to the indexer's forms.
 */
export function extractQueryIdentifiers(query: string, vocab?: Vocabulary): string[] {
  const found = new Set<string>(extractIdentifiers(query, vocab));
  for (const m of query.matchAll(TICKET_LOOSE_RE)) found.add(`${m[1]}-${m[2]}`.toUpperCase());
  return [...found];
}
