import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { canonicalize } from '../core/text/canonicalize.js';
import { sha256 } from '../core/hash.js';
import { parseNote, fmString } from '../core/frontmatter.js';
import { chunkNote } from '../core/markdown/chunker.js';
import { extractIdentifiers, type Vocabulary } from '../core/identifiers.js';
import { scanInjection, SCANNER_VERSION } from '../security/scan-injection.js';
import { scanSecrets, redact } from '../security/scan-secrets.js';

/**
 * Indexing of a vault file: classifies layer and provenance, chunks the note
 * and feeds the tables (the FTS tables follow via trigger). Reconcile
 * (reconcile.ts) decides WHAT to index; this is the HOW.
 */

export interface IndexerContext {
  db: Database.Database;
  vaultName: string;
  vaultRoot: string;
  vocab: Vocabulary;
  /**
   * True when this context indexes a registered EXTERNAL read-only root
   * (config `external_roots`; vaultName is then the synthetic `<vault>::<name>`
   * identity). Files there are written by a foreign tool, so classification is
   * hardened: see hardenExternal.
   */
  external?: boolean | undefined;
}

export type IndexFileResult = 'indexed' | 'unchanged' | 'skipped_not_utf8';

export type Origin = 'human_direct' | 'session_extract' | 'third_party_derived';

interface Classification {
  layer: 'curated' | 'reservoir' | 'raw';
  docType: string | null;
  docDate: string | null;
  origin: Origin;
  trust: 'curated' | 'session' | 'untrusted';
  status: 'active' | 'obsolete';
  isEvergreen: boolean;
}

const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

/** trust is ALWAYS derived from origin; a single concept (critique B2). */
export function trustFromOrigin(origin: Origin): Classification['trust'] {
  if (origin === 'human_direct') return 'curated';
  if (origin === 'session_extract') return 'session';
  return 'untrusted';
}

/**
 * Classifies by path (compared in lowercase: NTFS is case-insensitive) with a
 * frontmatter override. Absence of a marker never becomes trust: the default
 * origin is third_party_derived, except in the curated layer, which is edited
 * by the human by definition.
 */
export function classifyFile(relPath: string, fm: Record<string, unknown>): Classification {
  const lower = relPath.toLowerCase();
  const parts = lower.split('/');
  const top = parts.length > 1 ? parts[0]! : '';
  const base = path.posix.basename(lower, '.md');

  let layer: Classification['layer'] = 'reservoir';
  let docType: string | null = null;
  if (parts.length === 1 && (base === 'user' || base === 'memory')) {
    layer = 'curated'; docType = 'curated';
  } else if (top === 'meetings') {
    layer = 'raw'; docType = 'meeting';
  } else if (top === 'sessions') {
    layer = 'raw'; docType = 'session';
  } else if (top === 'topics') {
    docType = 'topic';
  } else if (top === 'people') {
    docType = 'person';
  } else if (top === 'work log' || top === 'worklog') {
    docType = 'worklog';
  } else if (top === 'daily') {
    docType = 'daily';
  } else if (top === 'projetos' || top === 'projects') {
    layer = 'curated'; docType = 'curated';
  }

  const fmLayer = fmString(fm, 'layer');
  if (fmLayer === 'curated' || fmLayer === 'reservoir' || fmLayer === 'raw') layer = fmLayer;
  const fmType = fmString(fm, 'type') ?? fmString(fm, 'doc_type');
  if (fmType) docType = fmType;

  let origin: Origin = layer === 'curated' ? 'human_direct' : 'third_party_derived';
  const fmOrigin = fmString(fm, 'origin');
  if (fmOrigin === 'human_direct' || fmOrigin === 'session_extract' || fmOrigin === 'third_party_derived') {
    origin = fmOrigin;
  }

  let docDate: string | null = null;
  const fmDate = fmString(fm, 'date');
  const fromFm = fmDate ? DATE_RE.exec(fmDate)?.[1] : undefined;
  const fromName = DATE_RE.exec(base)?.[1];
  docDate = fromFm ?? fromName ?? null;

  const status: Classification['status'] = fmString(fm, 'status') === 'obsolete' ? 'obsolete' : 'active';
  const isEvergreen = fm['evergreen'] === true || layer === 'curated';

  return { layer, docType, docDate, origin, trust: trustFromOrigin(origin), status, isEvergreen };
}

/**
 * Classification cap for files in an external root. The path conventions and
 * frontmatter of a foreign tool's folder are that TOOL's claims, not the
 * owner's, so nothing there may raise trust: origin is pinned to third-party
 * (=> untrusted, fenced, injection-scanned), and the curated layer is out of
 * reach — a curated layer would skip the injection scan, feed the capture
 * triage prompt, and rank as the owner's own words. Never evergreen for the
 * same reason: freshness decay must apply to status-like content.
 */
function hardenExternal(cls: Classification): Classification {
  return {
    ...cls,
    layer: cls.layer === 'curated' ? 'reservoir' : cls.layer,
    origin: 'third_party_derived',
    trust: trustFromOrigin('third_party_derived'),
    isEvergreen: false,
  };
}

/** UTF-16 BOM or invalid bytes: refuses to index (the ASCII regex would not match). */
function decodeUtf8Strict(buf: Buffer): string | undefined {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    return undefined;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return undefined;
  }
}

/**
 * Density tier of one chunk, a RANKING signal only (2026-07-29 review). It
 * answers "is this distilled text or verbatim speech?", nothing about trust:
 * the fence keeps following origin, and promotion rules do not read it.
 * Unknown shapes default to 'processed' so a parsing miss never demotes.
 */
export function tierOf(cls: Classification, headingPath: string | null): 'curated' | 'processed' | 'raw' {
  if (cls.layer === 'curated') return 'curated';
  // Session copies are verbatim conversation whatever their headings say.
  if (cls.docType === 'session') return 'raw';
  // In a meeting note only the Transcript section is verbatim; Summary,
  // Decisions and Next steps are the distilled layer. CONTAINS, not equals:
  // older synced notes carry the Gemini heading style, bold and prefixed
  // ('**Team Standup - Transcript**'), and those are transcripts too.
  if ((headingPath ?? '').split(' > ')[0]!.toLowerCase().includes('transcript')) return 'raw';
  return 'processed';
}

export function indexFile(
  ctx: IndexerContext,
  relPath: string,
  opts?: { force?: boolean },
): IndexFileResult {
  const abs = path.join(ctx.vaultRoot, relPath);
  const buf = fs.readFileSync(abs);
  const stat = fs.statSync(abs, { bigint: true });

  const text = decodeUtf8Strict(buf);
  if (text === undefined) {
    ctx.db.prepare('INSERT INTO index_log (at, action, path, detail) VALUES (?, ?, ?, ?)')
      .run(Date.now(), 'skip_not_utf8', relPath, null);
    return 'skipped_not_utf8';
  }

  const canonical = canonicalize(text);
  const hash = sha256(canonical);
  const pathLower = relPath.toLowerCase();

  const existing = ctx.db
    .prepare('SELECT id, content_hash, is_deleted, scanner_version FROM files WHERE vault = ? AND path_lower = ?')
    .get(ctx.vaultName, pathLower) as { id: number; content_hash: string; is_deleted: number; scanner_version: number } | undefined;

  // A newer scan rule voids the shortcut: reindex to repopulate inj_flags.
  // `force` voids it too: a vocabulary change invalidates the stored
  // identifiers, and the content hash cannot see that change.
  if (opts?.force !== true && existing && existing.content_hash === hash && existing.is_deleted === 0
    && existing.scanner_version >= SCANNER_VERSION) {
    ctx.db.prepare('UPDATE files SET mtime_ns = ?, size_bytes = ?, path = ?, indexed_at = ? WHERE id = ?')
      .run(stat.mtimeNs, buf.length, relPath, Date.now(), existing.id);
    return 'unchanged';
  }

  const note = parseNote(canonical);
  // The external cap comes AFTER classification, so it wins over both the path
  // conventions and any frontmatter override in the foreign file.
  const classified = classifyFile(relPath, note.data);
  const cls = ctx.external ? hardenExternal(classified) : classified;

  // Finding #4 (security hardening plan): files that reach the index outside the
  // write pipeline (authored in Obsidian, dropped in the folder, pulled via git)
  // are never secret-scanned. Scan here so a secret is never stored verbatim and
  // then handed back in a search snippet. On a hit, mask the value in every
  // client-facing / indexed chunk field with the same redact() used for
  // transcripts, and log the file so the redaction is auditable.
  const secretHit = scanSecrets(note.body).length > 0;
  if (secretHit) {
    ctx.db.prepare('INSERT INTO index_log (at, action, path, detail) VALUES (?, ?, ?, ?)')
      .run(Date.now(), 'redact_secret', relPath, null);
  }

  const chunks = chunkNote({
    fileLabel: path.posix.basename(relPath, path.posix.extname(relPath)),
    docDate: cls.docDate,
    body: note.body,
    baseOffset: canonical.length - note.body.length,
    baseLine: note.frontmatterLines,
  });

  const now = Date.now();
  const tx = ctx.db.transaction(() => {
    let fileId: number;
    if (existing) {
      ctx.db.prepare(`
        UPDATE files SET path = ?, layer = ?, doc_type = ?, doc_date = ?, status = ?, is_evergreen = ?,
          mtime_ns = ?, size_bytes = ?, file_index = ?, content_hash = ?, frontmatter = ?,
          origin = ?, trust = ?, scanner_version = ?, indexed_at = ?, is_deleted = 0
        WHERE id = ?
      `).run(
        relPath, cls.layer, cls.docType, cls.docDate, cls.status, cls.isEvergreen ? 1 : 0,
        stat.mtimeNs, buf.length, String(stat.ino), hash, JSON.stringify(note.data),
        cls.origin, cls.trust, SCANNER_VERSION, now, existing.id,
      );
      fileId = existing.id;
      // Explicit delete (not via CASCADE) so the triggers clean the FTS tables.
      ctx.db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileId);
    } else {
      const info = ctx.db.prepare(`
        INSERT INTO files (vault, path, path_lower, layer, doc_type, doc_date, status, is_evergreen,
          mtime_ns, size_bytes, file_index, content_hash, frontmatter, origin, trust, scanner_version, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ctx.vaultName, relPath, pathLower, cls.layer, cls.docType, cls.docDate, cls.status,
        cls.isEvergreen ? 1 : 0, stat.mtimeNs, buf.length, String(stat.ino), hash,
        JSON.stringify(note.data), cls.origin, cls.trust, SCANNER_VERSION, now,
      );
      fileId = Number(info.lastInsertRowid);
    }

    const insertChunk = ctx.db.prepare(`
      INSERT INTO chunks (file_id, ordinal, kind, heading_path, heading_slug, speaker, context_prefix,
        body, anchor_substring, identifiers, char_start, char_end, start_line, token_count,
        chunk_hash, origin, tier, inj_flags, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of chunks) {
      // Finding #4: when the file tripped the secret scan, redact every field that
      // is returned to the client (body -> snippet, heading, anchor -> match) or
      // fed to FTS/embeddings (context prefix, body). This closes the snippet,
      // heading, anchor and search-by-secret leak paths at once. Clean files skip
      // the extra work entirely, so normal indexing is unchanged.
      const contextPrefix = secretHit ? redact(c.contextPrefix).text : c.contextPrefix;
      const body = secretHit ? redact(c.body).text : c.body;
      const headingPath = secretHit && c.headingPath ? redact(c.headingPath).text : c.headingPath;
      const anchor = secretHit ? redact(c.anchorSubstring).text : c.anchorSubstring;
      const ids = extractIdentifiers(`${contextPrefix}\n${body}`, ctx.vocab);
      // The scan at read/index time never removes: it only marks (section 10 of the plan).
      const flags = cls.origin === 'human_direct' ? [] : scanInjection(body);
      insertChunk.run(
        fileId, c.ordinal, c.kind, headingPath, c.headingSlug, c.speaker, contextPrefix,
        body, anchor, ids.join(' '), c.charStart, c.charEnd, c.startLine,
        c.tokenCount, sha256(`${contextPrefix}\n${body}`), cls.origin,
        tierOf(cls, c.headingPath), flags.join(','), now,
      );
    }
  });
  tx();
  return 'indexed';
}

/** Removes a file from the index: chunks go, the record stays as a tombstone. */
export function removeFile(ctx: IndexerContext, relPath: string): void {
  const row = ctx.db
    .prepare('SELECT id FROM files WHERE vault = ? AND path_lower = ? AND is_deleted = 0')
    .get(ctx.vaultName, relPath.toLowerCase()) as { id: number } | undefined;
  if (!row) return;
  const tx = ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM chunks WHERE file_id = ?').run(row.id);
    ctx.db.prepare('UPDATE files SET is_deleted = 1, indexed_at = ? WHERE id = ?').run(Date.now(), row.id);
  });
  tx();
}
