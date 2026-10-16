import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Hook bundle rule (section 12): the RUNTIME import graph of session-start
 * must not touch a native dependency (better-sqlite3). The hook may only do
 * net + JSON; import type does not count (erased at compile time).
 */

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function runtimeImports(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/^import\s+(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/gms)) out.push(m[1]!);
  for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  return out;
}

function walk(entryRel: string): Set<string> {
  const seen = new Set<string>();
  const externals = new Set<string>();
  const queue = [path.join(SRC, entryRel)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of runtimeImports(file)) {
      if (spec.startsWith('.')) {
        queue.push(path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')));
      } else {
        externals.add(spec);
      }
    }
  }
  return externals;
}

describe('session-start hook bundle', () => {
  it('does not import better-sqlite3 or anything native at runtime', () => {
    const externals = walk('hooks/session-start.ts');
    expect([...externals].filter((e) => e.includes('better-sqlite3'))).toEqual([]);
    expect([...externals].filter((e) => e.includes('onnxruntime') || e.includes('@huggingface'))).toEqual([]);
    // Only the node platform is left, nothing heavier than net/crypto.
    for (const e of externals) expect(e.startsWith('node:'), e).toBe(true);
  });
});
