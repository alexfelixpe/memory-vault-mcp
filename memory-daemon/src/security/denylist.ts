import fs from 'node:fs';
import path from 'node:path';
import { appDataDir } from '../core/paths.js';

/**
 * Client-term denylist. Lives OUTSIDE Git (%APPDATA%\memory\
 * denylist-terms.txt): committing the list itself would be the leak.
 * Blocks writes into the curated layer and into project Topics.
 */

let cache: { terms: string[]; mtimeMs: number } | undefined;

function denylistPath(): string {
  return process.env['MEMORY_DENYLIST'] ?? path.join(appDataDir(), 'denylist-terms.txt');
}

export function loadDenylist(): string[] {
  const file = denylistPath();
  try {
    const stat = fs.statSync(file);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.terms;
    const terms = fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l.length >= 3 && !l.startsWith('#'));
    cache = { terms, mtimeMs: stat.mtimeMs };
    return terms;
  } catch {
    return [];
  }
}

/** Returns the first forbidden term found, or undefined. */
export function checkDenylist(text: string): string | undefined {
  const lower = text.toLowerCase();
  return loadDenylist().find((term) => lower.includes(term));
}
