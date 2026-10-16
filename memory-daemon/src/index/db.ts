import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { indexRootDir } from '../core/paths.js';

/**
 * Opens the SQLite index. The database lives at
 * %LOCALAPPDATA%\memory\index\gen-NNNNNN\index.db; the CURRENT file points to
 * the active generation. On Windows you cannot rename an open .db, so a rebuild
 * switches generation and rewrites CURRENT (decision A4); Increment 1 only
 * creates the initial generation.
 */

const SCHEMA_VERSION = 3;

export class IndexUnavailableError extends Error {
  readonly code = 'INDEX_UNAVAILABLE';
  constructor(root: string) {
    super(`No index at ${root}. Run: memory index`);
  }
}

export interface OpenIndexOptions {
  readonly?: boolean;
  /** Alternate root (tests). Default: %LOCALAPPDATA%\memory\index. */
  rootDir?: string;
}

function currentFile(root: string): string {
  return path.join(root, 'CURRENT');
}

/** Reads the active generation; undefined when the index was never created. */
export function readCurrentGeneration(root: string): string | undefined {
  try {
    const gen = fs.readFileSync(currentFile(root), 'utf8').trim();
    return /^gen-\d{6}$/.test(gen) ? gen : undefined;
  } catch {
    return undefined;
  }
}

export function indexDbPath(root: string, generation: string): string {
  return path.join(root, generation, 'index.db');
}

function applyPragmas(db: Database.Database, readonly: boolean): void {
  if (!readonly) db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');   // with WAL, safe against a process crash
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536');    // 64 MB
  db.pragma('mmap_size = 0');          // guards against someone turning mmap on later (note in section 6)
}

function schemaSqlPath(): string {
  return fileURLToPath(new URL('./schema.sql', import.meta.url));
}

function migrationsDir(): string {
  return fileURLToPath(new URL('./migrations/', import.meta.url));
}

/** Applies the initial schema or pending numbered migrations, via user_version. */
function migrate(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version === 0) {
    db.exec(fs.readFileSync(schemaSqlPath(), 'utf8'));
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    return;
  }
  if (version >= SCHEMA_VERSION) return;
  const files = fs.readdirSync(migrationsDir())
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();
  for (const f of files) {
    const num = Number(f.slice(0, 3));
    if (num <= version || num === 1) continue; // 001 = initial schema, already applied
    db.exec(fs.readFileSync(path.join(migrationsDir(), f), 'utf8'));
    db.pragma(`user_version = ${num}`);
  }
}

/**
 * Opens the index. In write mode it creates the initial generation if missing;
 * in read mode it throws IndexUnavailableError when there is no index.
 */
export function openIndexDb(opts: OpenIndexOptions = {}): Database.Database {
  const root = opts.rootDir ?? process.env['MEMORY_INDEX_DIR'] ?? indexRootDir();
  const readonly = opts.readonly ?? false;
  let gen = readCurrentGeneration(root);

  if (!gen) {
    if (readonly) throw new IndexUnavailableError(root);
    gen = 'gen-000001';
    fs.mkdirSync(path.join(root, gen), { recursive: true });
    // CURRENT starts pointing only after the directory exists.
    fs.writeFileSync(currentFile(root), gen + '\n', 'utf8');
  }

  const dbPath = indexDbPath(root, gen);
  if (readonly && !fs.existsSync(dbPath)) throw new IndexUnavailableError(root);

  const db = new Database(dbPath, { readonly, fileMustExist: readonly });
  applyPragmas(db, readonly);
  if (!readonly) migrate(db);
  return db;
}
