import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { MemoryConfig } from '../../core/config.js';
import { readableVaults, type ReadScope } from '../../core/vault-scope.js';
import { buildSearchContext } from '../../index/context.js';
import { memorySearch, type SearchHit, type VectorChannel } from '../../index/search/search.js';

/**
 * SessionStart retrieval push (section 9): builds the query from repo signals
 * (branch, diff, latest commits) and injects up to 3 relevant memories. Fixed
 * budget: 220 chars per snippet, 900 in the block, 1 per file. If nothing
 * passes, it injects NOTHING. The block freezes together with the snapshot.
 *
 * This block is injected with NO tool call, so it is the path where a leak would
 * be least visible: it obeys the session's own read scope, like every other
 * read. That means the session's vault alone, unless its repo opted in to the
 * shared vault.
 */

const MAX_HITS = 3;
const MAX_SNIPPET = 220;
const MAX_BLOCK = 900;

/**
 * The curated files (USER / MEMORY / PROJECT) open with a descriptive header
 * that explains the file itself ("Who you are…", the char budget, the edit
 * rules). That intro is prose under the H1, not a memory, and it used to
 * surface in the push as if it were one. Every REAL curated entry lives under a
 * '## Section', so its heading is 'FILE > Section'; the intro chunk's heading is
 * the bare file title with no ' > '. Drop bare-heading hits from curated files
 * ONLY, so no real entry is ever dropped and other files (daily, meetings) are
 * untouched.
 */
export function isCuratedFileIntro(hit: SearchHit): boolean {
  const rel = (hit.path_hint.split(':').pop() ?? '').toLowerCase();
  const curated = rel === 'user.md' || rel === 'memory.md' || rel === 'project.md';
  return curated && (hit.heading === null || !hit.heading.includes(' > '));
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      timeout: 400, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function buildPushQuery(cwd: string): string {
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const files = git(cwd, ['diff', '--name-only']).split('\n').slice(0, 8);
  const logs = git(cwd, ['log', '-n', '3', '--format=%s']).split('\n');
  const tickets = branch.match(/[A-Z][A-Z0-9]{1,7}-\d{1,6}/gi) ?? [];
  const terms = [...tickets, branch, ...files, ...logs]
    .join(' ')
    .replace(/\\/g, '/')            // '\' becomes '/' before becoming a term
    .replace(/[^\p{L}\p{N}\-_/. ]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 24);
  return [...new Set(terms)].join(' ');
}

export async function buildRetrievalPush(
  db: Database.Database,
  config: MemoryConfig,
  cwd: string | undefined,
  vector?: VectorChannel,
  scope?: ReadScope | undefined,
): Promise<string> {
  if (!cwd) return '';
  const query = buildPushQuery(cwd);
  if (query.length < 3) return '';

  let res;
  try {
    // Over-fetch a little: the intro-chunk filter below may drop some hits, and
    // we still want up to MAX_HITS real memories when the vault has them.
    // With no scope the caller did not resolve one, so this process's own
    // ambient scope decides — the same fallback readableVaults applies for any
    // client that sends nothing.
    const vaults = scope
      ? readableVaults(config, scope.vault, scope.shareGlobal)
      : readableVaults(config);
    res = await memorySearch(buildSearchContext(db, config, vector, vaults), { query, k: MAX_HITS + 2 });
  } catch {
    return ''; // push is optional; a missing index must not block the session
  }

  const parts: string[] = [];
  let used = 0;
  const seenFiles = new Set<string>();
  for (const hit of res.hits) {
    if (parts.length >= MAX_HITS) break;         // still at most 3 memories
    if (isCuratedFileIntro(hit)) continue;       // file-description header, not a memory
    if (seenFiles.has(hit.path_hint)) continue; // max 1 per file
    const snippet = hit.snippet.replace(/\s+/g, ' ').slice(0, MAX_SNIPPET);
    const line = `- ${hit.path_hint}${hit.heading ? ` (${hit.heading})` : ''}: ${snippet}`;
    if (used + line.length > MAX_BLOCK) break;
    used += line.length;
    seenFiles.add(hit.path_hint);
    parts.push(line);
  }
  if (parts.length === 0) return '';
  return `<!-- relevant memories for this repo -->\n${parts.join('\n')}`;
}
