import type Database from 'better-sqlite3';

/**
 * BM25 channel over chunks_fts (unicode61, tokenchars '-_/.'). A natural query
 * tries AND first (precision); zero results falls back to OR (recall) and bm25
 * re-ranks. Weights: context prefix 2x, body 1x, identifiers 4x.
 */

export interface LexicalHit {
  chunkId: number;
  /** Score already inverted: higher = better. */
  bm25: number;
}

export type Scope = 'all' | 'curated' | 'reservoir' | 'meetings' | 'daily';

/** SQL predicate for the scope, always over the files table (alias f). */
export function scopePredicate(scope: Scope): string {
  switch (scope) {
    case 'curated': return "AND f.layer = 'curated'";
    case 'reservoir': return "AND f.layer = 'reservoir'";
    case 'meetings': return "AND f.doc_type = 'meeting'";
    case 'daily': return "AND f.doc_type = 'daily'";
    case 'all': return '';
  }
}

/** A vault predicate plus the values to bind for it, in that order. */
export interface VaultPredicate {
  sql: string;
  params: string[];
}

/**
 * SQL predicate for vault read isolation, over the files table (alias f). Vault
 * names come from a config file, so they are bound as parameters and never
 * pasted into the SQL text. `undefined` (the human "all" path) filters nothing.
 *
 * An EMPTY list is a real answer: the caller may read nothing, because its repo
 * marker could not be honoured. It must hide everything, and it must never be
 * confused with "no filter". `IN ()` is not valid SQL, so this returns a
 * predicate that no row can satisfy.
 */
export function vaultPredicate(vaults: readonly string[] | undefined): VaultPredicate {
  if (vaults === undefined) return { sql: '', params: [] };
  if (vaults.length === 0) return { sql: 'AND 0', params: [] };
  return {
    sql: `AND f.vault IN (${vaults.map(() => '?').join(', ')})`,
    params: [...vaults],
  };
}

/** Tokens compatible with the index tokenizer (keeps PROJ-123, feat/x, e5-small). */
export function queryTerms(query: string): string[] {
  return [...query.normalize('NFC').matchAll(/[\p{L}\p{N}][\p{L}\p{N}\-_/.]*/gu)]
    .map((m) => m[0])
    .filter((t) => t.length > 0)
    .slice(0, 32); // a huge query does not become a huge FTS query
}

function ftsQuery(terms: string[], op: 'AND' | 'OR'): string {
  // Each term in double quotes: nothing from the user is read as FTS5 syntax.
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(op === 'AND' ? ' ' : ' OR ');
}

export function lexicalChannel(
  db: Database.Database,
  query: string,
  scope: Scope,
  pool: number,
  vaults?: readonly string[] | undefined,
): LexicalHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  // Vault isolation runs INSIDE the query, not after it: filtering afterwards
  // would let another vault's rows fill the pool and push the caller's own hits
  // out of it, so a scoped search would return fewer results than it should.
  const vault = vaultPredicate(vaults);
  const sql = `
    SELECT c.id AS chunk_id, bm25(chunks_fts, 2.0, 1.0, 4.0) AS rank
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    JOIN files f ON f.id = c.file_id
    WHERE chunks_fts MATCH ?
      AND f.is_deleted = 0 AND f.quarantined = 0
      ${scopePredicate(scope)}
      ${vault.sql}
    ORDER BY rank
    LIMIT ?
  `;
  const run = (match: string): LexicalHit[] =>
    (db.prepare(sql).all(match, ...vault.params, pool) as Array<{ chunk_id: number; rank: number }>)
      .map((r) => ({ chunkId: r.chunk_id, bm25: -r.rank }));

  const strict = run(ftsQuery(terms, 'AND'));
  if (strict.length > 0 || terms.length === 1) return strict;
  return run(ftsQuery(terms, 'OR'));
}

/**
 * Exact identifier lookup for the bypass: whole-word match on the identifiers
 * column of chunks (outside the BM25 ranking).
 */
export function lookupExactIds(
  db: Database.Database,
  ids: string[],
  scope: Scope,
  limit: number,
  vaults?: readonly string[] | undefined,
): number[] {
  if (ids.length === 0) return [];
  const found: number[] = [];
  // The bypass jumps the ranking, so it needs the same vault gate as the ranked
  // channels: without it, a ticket key would name another client's file outright.
  const vault = vaultPredicate(vaults);
  const stmt = db.prepare(`
    SELECT c.id AS chunk_id
    FROM chunks c
    JOIN files f ON f.id = c.file_id
    WHERE (' ' || c.identifiers || ' ') LIKE ?
      AND f.is_deleted = 0 AND f.quarantined = 0
      ${scopePredicate(scope)}
      ${vault.sql}
    ORDER BY f.doc_date DESC NULLS LAST, c.ordinal
    LIMIT ?
  `);
  for (const id of ids) {
    for (const row of stmt.all(`% ${id.replace(/[%_]/g, '')} %`, ...vault.params, limit) as Array<{ chunk_id: number }>) {
      if (!found.includes(row.chunk_id)) found.push(row.chunk_id);
    }
  }
  return found.slice(0, limit);
}
