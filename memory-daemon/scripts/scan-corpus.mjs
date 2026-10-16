// False-positive baseline of the injection scan over the real vaults.
// A rule may only become 'block' with under 1% firing (section 10).
// Usage: node scripts/scan-corpus.mjs   (requires npm run build first)
import fs from 'node:fs';
import path from 'node:path';
import { scanInjection } from '../dist/security/scan-injection.js';
import { loadConfig } from '../dist/core/config.js';

const SKIP = new Set(['.git', '.obsidian', '.memory', '.trash', 'node_modules', 'quarantine']);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name.toLowerCase())) yield* walk(path.join(dir, e.name));
    } else if (e.name.toLowerCase().endsWith('.md')) {
      yield path.join(dir, e.name);
    }
  }
}

const config = loadConfig({});
const counts = new Map();
let files = 0;
let flagged = 0;

for (const [vault, root] of Object.entries(config.vaults)) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    files++;
    const flags = scanInjection(fs.readFileSync(file, 'utf8'));
    if (flags.length > 0) {
      flagged++;
      for (const f of flags) counts.set(f, (counts.get(f) ?? 0) + 1);
      console.log(`${vault}: ${path.relative(root, file)} -> ${flags.join(', ')}`);
    }
  }
}

console.log(`\n${files} files scanned, ${flagged} fired (${files ? ((100 * flagged) / files).toFixed(2) : 0}%)`);
for (const [rule, n] of counts) console.log(`  ${rule}: ${n} files`);
