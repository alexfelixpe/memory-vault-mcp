import { normalizeForMatch } from '../text/normalize.js';

/**
 * Structural parser of a note: "##" headings and top-level bullets. It is
 * the base of memory_get and of the write's match resolution (Increment 4);
 * in Increment 1 it feeds the chunker with heading_path per section.
 */

export interface Entry {
  /** Bullet text without the marker, with continuation lines. */
  text: string;
  /** 1-based line WITHIN the body passed to the parser. */
  line: number;
  charStart: number;
  charEnd: number;
}

export interface Section {
  /** Heading name; '' for the preamble before the first heading. */
  name: string;
  level: number;
  line: number;
  charStart: number;
  charEnd: number;
  entries: Entry[];
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const BULLET_RE = /^[-*+]\s+/;
const FENCE_RE = /^(```|~~~)/;

/** Splits the body into sections by heading, ignoring headings inside a code fence. */
export function parseSections(body: string): Section[] {
  const lines = body.split('\n');
  const sections: Section[] = [];
  let current: Section = { name: '', level: 0, line: 1, charStart: 0, charEnd: body.length, entries: [] };
  let inFence = false;
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) inFence = !inFence;
    const h = inFence ? null : HEADING_RE.exec(line);
    if (h) {
      current.charEnd = offset;
      // Empty preamble (file starts straight at a heading) does not become a section.
      if (current.name !== '' || current.entries.length > 0 || body.slice(current.charStart, offset).trim() !== '') {
        sections.push(current);
      }
      // The <!-- auto --> marker lives in the heading but is not part of the NAME.
      const name = h[2]!.replace(/<!--[\s\S]*?-->/g, '').trim();
      current = { name, level: h[1]!.length, line: i + 1, charStart: offset, charEnd: body.length, entries: [] };
    } else if (!inFence && BULLET_RE.test(line)) {
      // Top-level bullet; the following indented lines are continuation.
      let text = line.replace(BULLET_RE, '');
      let end = offset + line.length;
      let j = i + 1;
      let extra = 0;
      while (j < lines.length && /^\s{2,}\S/.test(lines[j]!) && !BULLET_RE.test(lines[j]!.trimStart())) {
        text += ' ' + lines[j]!.trim();
        end += 1 + lines[j]!.length;
        extra++;
        j++;
      }
      current.entries.push({ text, line: i + 1, charStart: offset, charEnd: end });
      i += extra;
      offset = end + 1;
      continue;
    }
    offset += line.length + 1;
  }
  current.charEnd = body.length;
  sections.push(current);
  return sections;
}

export type ResolveResult =
  | { status: 'unique'; entry: Entry; section: Section }
  | { status: 'ambiguous'; candidates: Array<{ entry: Entry; section: Section; index: number }> }
  | { status: 'none' };

/**
 * Resolves a textual match to exactly one entry. Never picks the first on a
 * tie: ambiguity is returned to the caller (test T2).
 */
export function resolveEntry(sections: Section[], match: string, sectionName?: string): ResolveResult {
  const needle = normalizeForMatch(match);
  const pool = sectionName === undefined
    ? sections
    : sections.filter((s) => normalizeForMatch(s.name) === normalizeForMatch(sectionName));
  const candidates: Array<{ entry: Entry; section: Section; index: number }> = [];
  let index = 0;
  for (const section of pool) {
    for (const entry of section.entries) {
      if (normalizeForMatch(entry.text).includes(needle)) {
        candidates.push({ entry, section, index });
      }
      index++;
    }
  }
  if (candidates.length === 0) return { status: 'none' };
  if (candidates.length === 1) return { status: 'unique', entry: candidates[0]!.entry, section: candidates[0]!.section };
  return { status: 'ambiguous', candidates };
}
