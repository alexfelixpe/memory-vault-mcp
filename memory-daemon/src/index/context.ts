import type Database from 'better-sqlite3';
import type { MemoryConfig } from '../core/config.js';
import { loadRegistryVocab } from '../core/identifiers.js';
import { isReadableVault } from '../core/vault-scope.js';
import type { SearchContext, VectorChannel } from './search/search.js';

/**
 * Builds the search context: the database, the readable-vault set, and the
 * vocabulary of the _registry.md of each READABLE vault. The vector channel is
 * optional: only the daemon (which has the embedder) injects it.
 *
 * The vocabulary is scoped too, and that is not cosmetic: vocabulary terms drive
 * identifier extraction and the exact-match bypass, so an unscoped vocabulary
 * would let another client's project names change how this caller's query is
 * read.
 */
export function buildSearchContext(
  db: Database.Database,
  config: MemoryConfig,
  vector?: VectorChannel,
  vaults?: readonly string[] | undefined,
): SearchContext {
  const vocab = new Set<string>();
  for (const [name, root] of Object.entries(config.vaults)) {
    // Skip a vault this caller may not read; undefined vaults means "all", which
    // only the human cross-vault search produces.
    if (!isReadableVault(vaults, name)) continue;
    for (const term of loadRegistryVocab(root)) vocab.add(term);
  }
  return { db, vocab, vector, vaults };
}
