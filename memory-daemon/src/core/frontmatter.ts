import matter from 'gray-matter';

/**
 * Reading YAML frontmatter with gray-matter. Read-only in Increment 1;
 * writing (which must preserve key order) arrives with the write pipeline
 * in Increment 4.
 */

export interface ParsedNote {
  /** Frontmatter as a flat object; {} when absent or invalid. */
  data: Record<string, unknown>;
  /** Body without the frontmatter. */
  body: string;
  /** How many lines the frontmatter block spans in the file (0 if absent). */
  frontmatterLines: number;
}

/** Extracts frontmatter without throwing: broken YAML becomes empty frontmatter. */
export function parseNote(raw: string): ParsedNote {
  try {
    const parsed = matter(raw);
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    // gray-matter returns the body without the frontmatter; the block's line
    // count is used to convert a body offset into a real line number.
    const fmLines = parsed.matter ? parsed.matter.split('\n').length + 1 : 0;
    return { data, body: parsed.content, frontmatterLines: fmLines };
  } catch {
    return { data: {}, body: raw, frontmatterLines: 0 };
  }
}

/** Reads a string field from the frontmatter, tolerant of the wrong type. */
export function fmString(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  // Unquoted YAML turns 2026-07-21 into a Date; normalize to short ISO.
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return String(v);
  return undefined;
}
