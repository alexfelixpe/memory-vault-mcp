import type Database from 'better-sqlite3';
import { scopePredicate, vaultPredicate, type Scope } from './lexical.js';

/**
 * Substring channel over chunks_trigram. It does NOT take part in the fusion
 * ranking (trigram ranks character similarity, not word similarity): it serves
 * only for partial-fragment lookup and anchor re-resolution (decision in
 * section 2 of the plan).
 */

/** Literal substring search (minimum 3 chars, the trigram tokenizer limit). */
export function trigramSubstring(
  db: Database.Database,
  fragment: string,
  scope: Scope,
  limit: number,
  vaults?: readonly string[] | undefined,
): number[] {
  const clean = fragment.trim();
  if (clean.length < 3) return [];
  // This channel is the last-chance fallback for a single-word query, so it is
  // also the easiest hole to forget: scope it to the readable vaults like every
  // other query path.
  const vault = vaultPredicate(vaults);
  const rows = db.prepare(`
    SELECT c.id AS chunk_id
    FROM chunks_trigram
    JOIN chunks c ON c.id = chunks_trigram.rowid
    JOIN files f ON f.id = c.file_id
    WHERE chunks_trigram MATCH ?
      AND f.is_deleted = 0 AND f.quarantined = 0
      ${scopePredicate(scope)}
      ${vault.sql}
    LIMIT ?
  `).all(`"${clean.replace(/"/g, '""')}"`, ...vault.params, limit) as Array<{ chunk_id: number }>;
  return rows.map((r) => r.chunk_id);
}

/**
 * Anchor re-resolution: given a possibly stale anchor_substring, returns the
 * chunks of the file that still contain it.
 */
export function resolveAnchor(
  db: Database.Database,
  fileId: number,
  anchor: string,
  limit = 5,
): number[] {
  const clean = anchor.trim();
  if (clean.length < 3) return [];
  const rows = db.prepare(`
    SELECT c.id AS chunk_id
    FROM chunks_trigram
    JOIN chunks c ON c.id = chunks_trigram.rowid
    WHERE chunks_trigram MATCH ? AND c.file_id = ?
    LIMIT ?
  `).all(`"${clean.replace(/"/g, '""')}"`, fileId, limit) as Array<{ chunk_id: number }>;
  return rows.map((r) => r.chunk_id);
}
