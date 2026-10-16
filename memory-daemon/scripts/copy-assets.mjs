// Copy the .sql files (schema and migrations) into dist/, because tsc only
// emits .ts. db.ts resolves these files relative to its own module (import.meta.url).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, '..', 'src');
const dist = path.join(root, '..', 'dist');

for (const rel of ['index/schema.sql', 'index/migrations']) {
  const from = path.join(src, rel);
  const to = path.join(dist, rel);
  fs.cpSync(from, to, { recursive: true });
  console.log(`copied: ${rel}`);
}
