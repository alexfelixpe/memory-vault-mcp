import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type pino from 'pino';
import { readProjectMarker, type MemoryConfig } from '../core/config.js';
import {
  ambientReadVault, ambientReadScope, readableVaults, markerFixHint, GLOBAL_VAULT,
  type MarkerProblem, type ReadScope,
} from '../core/vault-scope.js';
import { canonicalize } from '../core/text/canonicalize.js';
import { detectEol, applyEol, type Eol } from '../core/text/eol.js';
import { normalizeForMatch } from '../core/text/normalize.js';
import { sha256 } from '../core/hash.js';
import { parseSections, type Section, type Entry } from '../core/markdown/sections.js';
import { atomicWriteMarkdown, backupBeforeWrite } from '../core/atomic-write.js';
import { budgetInfo, BUDGETS, stripComments } from '../core/budget.js';
import { ulid, memComment, parseBulletSrc, mergeOrigin, type Origin } from '../core/provenance.js';
import { appendWriteLog, sanitizeClientName, type WriteLogEntry } from '../core/write-log.js';
import { scanSecrets } from '../security/scan-secrets.js';
import { checkDenylist } from '../security/denylist.js';
import { scanInjection } from '../security/scan-injection.js';
import { indexFile, type IndexerContext } from '../index/indexer.js';

/**
 * Single write pipeline (section 7 of the plan), fixed order: serial queue ->
 * re-read from disk -> 3-level hash precondition -> secret scan -> denylist ->
 * injection scan -> dry-run -> budget over the FINAL state -> atomic write
 * with backup. The daemon is the ONLY process that goes through here.
 */

export type MemoryFile = 'user' | 'memory' | 'project' | { archive: string };

export interface MutateOp {
  op: 'add' | 'replace' | 'remove';
  section: string;
  text?: string | undefined;
  match?: string | undefined;
  after?: string | undefined;
  source?: 'user' | 'inferred' | 'third_party' | undefined;
  demote?: boolean | undefined;
}

export interface MutateParams {
  file: MemoryFile;
  expect: { sectionHash?: string | undefined; fileHash?: string | undefined; entryHash?: string | undefined };
  ops: MutateOp[];
  reason?: string | undefined;
  /** Caller's project vault (the proxy injects it; the model never sends a path). */
  vault?: string | undefined;
  actor?: string | undefined;
  session_id?: string | undefined;
  /**
   * Connecting app's display name (MCP clientInfo.name), for the audit log only.
   * It NEVER affects the write (the auto-section gate keys on `actor`, not this).
   */
  client?: string | undefined;
}

/** Typed error: becomes the envelope { code, message, hint, ...data } in MCP. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface WriteDeps {
  db: Database.Database;
  config: MemoryConfig;
  log: pino.Logger;
  indexerCtxFor(vault: string): IndexerContext | undefined;
  /**
   * SessionStart retrieval push; absent = snapshot without push. `scope` is the
   * session's own read scope, so the pushed memories obey the same rule a search
   * from that repo would.
   */
  buildPush?: ((cwd: string | undefined, scope: ReadScope) => Promise<string>) | undefined;
}

interface ResolvedFile {
  kind: 'user' | 'memory' | 'project';
  isArchive: boolean;
  vaultName: string;
  vaultRoot: string;
  relPath: string;
  absPath: string;
}

/**
 * The refusal for anything that needs the caller's PROJECT vault while the
 * repo's `.memory.yml` cannot be honoured. One factory so the client-side check
 * and the pipeline-side check give the exact same code, message and hint.
 *
 * Failing closed is the point: `config.defaultVault` is the vault of whatever
 * repo configured this process, and in a multi-client setup that is ANOTHER
 * client's vault. Writing there because of a typo is a confidentiality break,
 * so the write is refused and the human is told which file to fix.
 */
export function vaultUnresolvedError(marker: MarkerProblem): ToolError {
  return new ToolError('VAULT_UNRESOLVED',
    'This repo says which vault it belongs to, but that marker could not be used, so there is no '
    + 'project memory to write to here.',
    markerFixHint(marker) + ' Until then, use file: "memory" for a fact that is not tied to this repo.',
    { marker_file: marker.markerFile ?? null, marker_vault: marker.markerVault ?? null });
}

/**
 * The vault name a CLIENT (the human CLI, the MCP proxy) should send for an
 * operation on `file`, or a refusal when it cannot know one.
 *
 * The daemon is a single shared process: its own config carries the marker of
 * whatever repo started it, so it cannot tell that THIS caller's marker is
 * broken. The caller therefore resolves the target vault itself, exactly as it
 * already resolves the readable vault.
 *
 * Every curated file (USER.md, MEMORY.md, PROJECT.md) now lives in the CALLER's
 * own vault, so all three depend on the marker and all three refuse when it
 * cannot be honoured. `user` and `memory` used to be pinned to the shared vault
 * and were therefore exempt; they are not any more, because a vault we cannot
 * name has no USER.md we may write to. The refusal covers reads as well as
 * writes: reading another vault's USER.md is the same confidentiality break as
 * writing into it.
 */
export function resolveTargetVault(config: MemoryConfig): string {
  const vault = ambientReadVault(config);
  // undefined means the repo marker could not be honoured. Refuse rather than
  // guess: `config.defaultVault` here belongs to whichever repo configured this
  // process, and in a multi-vault setup that is another tenant's vault.
  if (vault === undefined) throw vaultUnresolvedError(config);
  return vault;
}

export function resolveMemoryFile(config: MemoryConfig, file: MemoryFile, vaultHint?: string): ResolvedFile {
  const base = typeof file === 'object' ? file.archive : file;
  const isArchive = typeof file === 'object';
  if (base !== 'user' && base !== 'memory' && base !== 'project') {
    throw new ToolError('FILE_NOT_FOUND', `Logical file '${String(base)}' does not exist.`,
      "Use file: 'user' | 'memory' | 'project' | { archive: 'user'|'memory'|'project' }.");
  }
  // Fail closed BY CONSTRUCTION, before any vault name is chosen: a process that
  // could not honour its repo marker does not know whose repo it is in, so
  // `config.defaultVault` here would be a guess, and in a multi-vault setup the
  // guess is another tenant's vault. This guard covers the offline CLI
  // read/write path and a daemon started inside a broken repo; a client talking
  // to a shared daemon is covered by resolveTargetVault, because the daemon's own
  // config cannot see the caller's marker. In production the daemon loads its
  // config with no cwd, so markerBroken is never set there.
  if (config.markerBroken) throw vaultUnresolvedError(config);
  // Every vault is self-contained: it holds its own USER.md, MEMORY.md and
  // PROJECT.md. The caller's vault decides all three, so a fact written in a
  // client's repo never lands in the personal shared vault.
  const vaultName = vaultHint ?? config.defaultVault;
  let relPath = base === 'user' ? 'USER.md' : base === 'memory' ? 'MEMORY.md' : 'PROJECT.md';
  if (base === 'project' && vaultName === GLOBAL_VAULT) {
    // The shared vault is the personal layer, not a project. `memory init` seeds
    // USER.md and MEMORY.md there and no PROJECT.md, so this stays a clear
    // refusal rather than a FILE_NOT_FOUND on a file that was never meant to be.
    throw new ToolError('FILE_NOT_FOUND', 'There is no project vault in this context.',
      'Run from a repo with .memory.yml pointing at the project vault, or use file: "memory".');
  }
  if (isArchive) relPath = relPath.replace(/\.md$/, '-archive.md');
  const vaultRoot = config.vaults[vaultName];
  if (!vaultRoot) {
    throw new ToolError('FILE_NOT_FOUND', `Vault '${vaultName}' is not configured.`,
      `Valid vaults: ${Object.keys(config.vaults).join(', ')}.`);
  }
  return { kind: base, isArchive, vaultName, vaultRoot, relPath, absPath: path.join(vaultRoot, relPath) };
}

// ---------- serial queue per file (key = absolute path) ----------

const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(absPath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(absPath, next.catch(() => undefined));
  return next;
}

// ---------- read and hashes ----------

interface FileState {
  raw: string;
  canonical: string;
  eol: Eol;
  fileHash: string;
  sections: Section[];
  sectionHash(name: string): string | undefined;
}

function readState(absPath: string, vaultName: string): FileState {
  let raw = '';
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    // The old hint claimed the file "is born with the vault". That was false for
    // any vault registered with `memory vault add`, so a person hit
    // FILE_NOT_FOUND and was told the file should already be there. Say instead
    // which command creates it, in each of the three situations that lead here:
    // no setup yet, a vault not registered yet, and (the common one) a vault
    // registered before `memory vault add` started seeding these files.
    throw new ToolError('FILE_NOT_FOUND', `${absPath} does not exist on disk.`,
      `This vault is already registered, so the fix is: memory vault seed ${vaultName}. `
      + 'It creates the curated files that are missing and never overwrites one that is there. '
      + '(`memory init` creates USER.md and MEMORY.md for a first vault; `memory vault add` '
      + 'creates the curated files in the vault it registers.) If the file is still missing, '
      + 'create it by hand: one "# TITLE" heading, then a section heading marked <!-- auto --> '
      + 'so writes have a target. Then retry.');
  }
  const canonical = canonicalize(raw);
  const sections = parseSections(canonical);
  return {
    raw,
    canonical,
    eol: detectEol(raw),
    fileHash: sha256(canonical),
    sections,
    sectionHash: (name) => {
      const s = sections.find((x) => normalizeForMatch(x.name) === normalizeForMatch(name));
      return s ? sha256(canonical.slice(s.charStart, s.charEnd)) : undefined;
    },
  };
}

const entryHashOf = (e: Entry): string => sha256(stripComments(e.text).trim());

function entriesPayload(sections: Section[]): Array<{ section: string; text: string; line: number; entry_hash: string }> {
  return sections.flatMap((s) => s.entries.map((e) => ({
    section: s.name,
    text: stripComments(e.text).trim(),
    line: e.line,
    entry_hash: entryHashOf(e),
  })));
}

function currentHashes(state: FileState): Record<string, unknown> {
  const sections: Record<string, string> = {};
  for (const s of state.sections) {
    if (s.name) sections[s.name] = sha256(state.canonical.slice(s.charStart, s.charEnd));
  }
  return { fileHash: state.fileHash, sections };
}

// ---------- memory_get ----------

export interface GetParams {
  file: MemoryFile;
  section?: string | undefined;
  vault?: string | undefined;
  citation?: { path: string; heading?: string | undefined; match?: string | undefined } | undefined;
  neighborhood?: 'entry' | 'section' | 'file' | undefined;
}

export function runGet(config: MemoryConfig, params: GetParams): Record<string, unknown> {
  const resolved = resolveMemoryFile(config, params.file, params.vault);
  const state = readState(resolved.absPath, resolved.vaultName);
  const wanted = params.section
    ? state.sections.filter((s) => normalizeForMatch(s.name) === normalizeForMatch(params.section!))
    : state.sections;
  if (params.section && wanted.length === 0) {
    throw new ToolError('NO_MATCH', `Section '${params.section}' does not exist in ${resolved.relPath}.`,
      `Available sections: ${state.sections.map((s) => s.name).filter(Boolean).join(', ')}. Repeat memory_get without 'section' to see everything.`,
      { sections: state.sections.map((s) => s.name).filter(Boolean) });
  }
  return {
    file: params.file,
    path_hint: `${resolved.vaultName}:${resolved.relPath}`,
    hash: currentHashes(state),
    budget: budgetInfo(state.canonical, resolved.kind),
    sections: wanted.filter((s) => s.name).map((s) => ({
      name: s.name,
      auto: state.canonical.slice(s.charStart, s.charEnd).includes('<!-- auto -->'),
      section_hash: sha256(state.canonical.slice(s.charStart, s.charEnd)),
      entries: s.entries.map((e) => ({ text: stripComments(e.text).trim(), line: e.line, entry_hash: entryHashOf(e) })),
    })),
    trust: 'curated',
  };
}

// ---------- memory_add / replace / remove (single batch engine) ----------

const attempts = new Map<string, { count: number; at: number }>();
const ATTEMPT_TTL_MS = 30 * 60_000;

function bumpAttempt(key: string): number {
  const now = Date.now();
  const cur = attempts.get(key);
  const count = cur && now - cur.at < ATTEMPT_TTL_MS ? cur.count + 1 : 1;
  attempts.set(key, { count, at: now });
  return count;
}

const originOfSource = (source: MutateOp['source']): Origin =>
  source === 'user' ? 'human_direct' : source === 'third_party' ? 'third_party_derived' : 'session_extract';

interface Patch {
  start: number;
  end: number;
  text: string;
}

export async function runMutate(deps: WriteDeps, params: MutateParams): Promise<Record<string, unknown>> {
  const resolved = resolveMemoryFile(deps.config, params.file, params.vault);
  if (params.ops.length < 1 || params.ops.length > 20) {
    throw new ToolError('BAD_REQUEST', 'The batch accepts 1 to 20 ops.', 'Split the change into smaller batches.');
  }

  return enqueue(resolved.absPath.toLowerCase(), async () => {
    // 2-3. Re-read from disk and canonicalize. Never trust a cache.
    const state = readState(resolved.absPath, resolved.vaultName);

    // 4. Three-level precondition with short-circuit.
    const attemptKey = resolved.absPath.toLowerCase();
    const staleData = (which: string): never => {
      throw new ToolError('STALE_HASH',
        `The ${which} changed since you read it (concurrent edit, probably Obsidian).`,
        'Re-read with memory_get, reassess whether the change still makes sense, and retry with the new hashes.',
        {
          conflict: which,
          current_hash: currentHashes(state),
          current_entries: entriesPayload(state.sections),
          attemptsLeft: Math.max(0, 3 - (attempts.get(attemptKey)?.count ?? 0)),
        });
    };
    if (params.expect.fileHash && params.expect.fileHash !== state.fileHash) staleData('file');
    const opSections = [...new Set(params.ops.map((o) => o.section))];
    if (params.expect.sectionHash) {
      if (opSections.length > 1 && !params.expect.fileHash) {
        throw new ToolError('BAD_REQUEST', 'A batch touching more than one section requires expect.fileHash.',
          'Call memory_get, take hash.fileHash and retry.');
      }
      const target = opSections[0]!;
      if (state.sectionHash(target) !== params.expect.sectionHash) staleData(`section '${target}'`);
    } else if (!params.expect.fileHash) {
      throw new ToolError('BAD_REQUEST', 'expect.sectionHash (or fileHash) is required.',
        'Call memory_get first; the response carries the hashes.');
    }

    // A direct human CLI write is the ONLY write exempt from the injection scan
    // and the auto-section gate. The exemption keys on the SERVER-SET `actor`
    // ('user_cli', stamped by the daemon for `memory add` / `memory edit` /
    // `memory forget`), NEVER on the client-supplied `source`. An MCP agent can
    // claim source:'user', but it cannot make the proxy send actor:'user_cli'
    // (the mutate tool schema has no actor field and the proxy overwrites actor
    // with the tool name). So every AGENT write — and every captured,
    // auto-promoted write (actor 'auto_promote') — is always scanned. Captured
    // text is never treated as typed-by-hand.
    const humanCli = params.actor === 'user_cli';

    // 5. A secret blocks in ALL layers.
    for (const op of params.ops) {
      const finding = op.text ? scanSecrets(op.text)[0] : undefined;
      if (finding) {
        throw new ToolError('SECRET_BLOCKED',
          `The text contains a secret (rule ${finding.rule}, starts with '${finding.preview}').`,
          'Remove the sensitive value and write only the reference (e.g. "key in 1Password").',
          { rule: finding.rule });
      }
      // 6. Client denylist in the curated layer.
      const denied = op.text ? checkDenylist(op.text) : undefined;
      if (denied) {
        throw new ToolError('DENYLIST_BLOCKED', 'The text contains a term from the client denylist.',
          'Rewrite without naming the client; the denylist protects the Git repo.', { term_length: denied.length });
      }
      // 7. Injection: only inj.persist/inj.exfil, only the curated layer. Every
      // write is scanned EXCEPT a direct human CLI write (actor 'user_cli'): the
      // human typing at the terminal is trusted; an agent claiming source:'user'
      // is not, so it is still scanned. Keying on `source` here was the poison
      // hole — an agent could set source:'user' and skip the scan.
      if (op.text && !humanCli) {
        const flags = scanInjection(op.text).filter((f) => f === 'inj.persist' || f === 'inj.exfil');
        if (flags.length > 0) {
          throw new ToolError('INJECTION_SUSPECTED',
            `The text looks like an injected instruction (${flags.join(', ')}).`,
            'This reads as an injected instruction, not a stored fact, so it was refused. ' +
            'If the owner of this memory really wants it stored, they must add it themselves at the terminal '
            + 'with `memory add`. That is the only trusted path.',
            { flags });
        }
      }
      // Third-party content NEVER enters the curated layer through this pipeline.
      // The review queue used to be the one exception (a human could approve an
      // item and the write carried an approval flag). The queue is gone, so the
      // block is now unconditional: nothing can turn it off.
      if (op.op === 'add' && op.source === 'third_party') {
        throw new ToolError('THIRD_PARTY_BLOCKED',
          'Third-party-derived content does not enter the curated layer.',
          'Record it with daily_append, or write it yourself at the terminal with `memory add` if you stand behind it.');
      }
    }

    // 8. Dry-run the whole batch in memory.
    const patches: Patch[] = [];
    const applied: Array<Record<string, unknown>> = [];
    const archiveLines: string[] = [];

    const findSection = (name: string): Section => {
      const s = state.sections.find((x) => normalizeForMatch(x.name) === normalizeForMatch(name));
      if (!s) {
        throw new ToolError('NO_MATCH', `Section '${name}' does not exist.`,
          `Sections: ${state.sections.map((x) => x.name).filter(Boolean).join(', ')}. Use an existing one.`);
      }
      return s;
    };

    const resolveOne = (op: MutateOp, section: Section): Entry => {
      const needle = normalizeForMatch(op.match ?? '');
      if (needle.length < 3) {
        throw new ToolError('BAD_REQUEST', 'match needs 3 to 200 characters.', 'Increase the match snippet.');
      }
      const candidates = section.entries.filter((e) => normalizeForMatch(e.text).includes(needle));
      if (candidates.length === 0) {
        const suggestions = section.entries.map((e) => stripComments(e.text).trim()).slice(0, 5);
        throw new ToolError('NO_MATCH', `No bullet in section '${section.name}' contains '${op.match}'.`,
          'Check the current entries and retry with an exact snippet.', { suggestions });
      }
      if (candidates.length > 1) {
        throw new ToolError('AMBIGUOUS_MATCH',
          `${candidates.length} bullets contain '${op.match}'; I never pick the first one.`,
          'Retry with a more specific match or with the entryHash of the right candidate.',
          {
            candidates: candidates.map((e, index) => ({
              index, text: stripComments(e.text).trim(), line: e.line, entry_hash: entryHashOf(e),
            })),
          });
      }
      const entry = candidates[0]!;
      if (params.expect.entryHash && entryHashOf(entry) !== params.expect.entryHash) staleData('bullet');
      return entry;
    };

    for (const op of params.ops) {
      const section = findSection(op.section);
      const sectionText = state.canonical.slice(section.charStart, section.charEnd);

      if (op.op === 'add') {
        if (!op.text || op.text.length < 1 || op.text.length > 400) {
          throw new ToolError('BAD_REQUEST', 'add requires text of 1 to 400 chars (one sentence).', 'Shorten the text.');
        }
        // Auto-section gate. It stops AGENTS (inferred / third-party writes) from
        // writing into sections the human reserved. A HUMAN typing at the CLI
        // states their own curated memory and is allowed into ANY section. The
        // bypass keys on the actor the DAEMON stamps per call path ('user_cli'
        // for the CLI), never on the op's `source`: an MCP agent can set
        // source:'user', but it cannot make the proxy send actor:'user_cli' (the
        // mutate tool schema has no actor field and the proxy overwrites actor
        // with the tool name). So a raw agent/MCP write still hits SECTION_NOT_AUTO.
        // `humanCli` is defined once at the top of this write (same actor rule).
        if (!humanCli && !sectionText.includes('<!-- auto -->')) {
          throw new ToolError('SECTION_NOT_AUTO', `Section '${section.name}' does not accept automatic writes.`,
            'Write in a section marked with <!-- auto --> (see memory_get) or ask the owner of this memory to mark this one.');
        }
        // Curated dedup: refuse an add whose exact bullet text already exists in
        // the target section. Without this a double-add makes two identical
        // bullets, which memory forget then cannot disambiguate (AMBIGUOUS_MATCH),
        // leaving the entry unremovable via the CLI. Comparison is on the visible
        // text only (comments and the '- ' marker stripped), so provenance never
        // masks it.
        const incoming = op.text.trim();
        if (section.entries.some((e) => stripComments(e.text).trim() === incoming)) {
          throw new ToolError('DUPLICATE_ENTRY',
            `That exact entry already exists in section '${section.name}'.`,
            'Nothing to add; edit the existing bullet (memory edit) or add a different fact.',
            { section: section.name });
        }
        const id = ulid();
        const line = `- ${op.text} ${memComment(id, originOfSource(op.source))}`;
        let insertAt = section.charEnd;
        if (op.after) {
          const anchor = section.entries.find((e) => normalizeForMatch(e.text).includes(normalizeForMatch(op.after!)));
          if (anchor) insertAt = anchor.charEnd + 1;
        } else {
          const lastEntry = section.entries[section.entries.length - 1];
          if (lastEntry) insertAt = lastEntry.charEnd + 1;
        }
        patches.push({ start: insertAt, end: insertAt, text: line + '\n' });
        applied.push({ op: 'add', section: section.name, id });
      } else {
        const entry = resolveOne(op, section);
        if (op.op === 'replace') {
          if (!op.text) throw new ToolError('BAD_REQUEST', 'replace requires text.', 'Include the new text.');
          const prov = parseBulletSrc(entry.text);
          const origin = prov ? mergeOrigin(prov.origin, originOfSource(op.source)) : originOfSource(op.source);
          const line = `- ${op.text} ${memComment(prov?.id ?? ulid(), origin)}`;
          patches.push({ start: entry.charStart, end: entry.charEnd, text: line });
          applied.push({ op: 'replace', section: section.name, id: prov?.id });
        } else {
          patches.push({ start: entry.charStart, end: Math.min(entry.charEnd + 1, state.canonical.length), text: '' });
          if (op.demote) archiveLines.push(`- ${stripComments(entry.text).trim()} <!-- demoted ${new Date().toISOString().slice(0, 10)} -->`);
          applied.push({ op: 'remove', section: section.name, demoted: op.demote === true });
        }
      }
    }

    // Apply back to front so the offsets don't shift.
    let final = state.canonical;
    for (const p of [...patches].sort((a, b) => b.start - a.start)) {
      final = final.slice(0, p.start) + p.text + final.slice(p.end);
    }
    final = canonicalize(final);

    // 9. Budget over the FINAL state, with a terminal outcome (critique A2).
    const limit = BUDGETS[resolved.kind]!;
    let consolidated = false;
    if (!resolved.isArchive) {
      let info = budgetInfo(final, resolved.kind);
      if (info.used_chars > limit) {
        const batchChars = params.ops.reduce((s, o) => s + (o.text?.length ?? 0), 0);
        if (batchChars > limit) {
          throw new ToolError('BATCH_TOO_LARGE', `The batch alone (${batchChars} chars) exceeds the ${limit} ceiling.`,
            'Reduce the batch; curated memory is made of short sentences.', { final: true });
        }
        const attempt = bumpAttempt(attemptKey);
        if (resolved.kind === 'user' || attempt < 3) {
          const finalSections = parseSections(final);
          const demotion = entriesPayload(finalSections)
            .sort((a, b) => b.text.length - a.text.length)
            .slice(0, 5);
          throw new ToolError('BUDGET_EXCEEDED',
            `The final result would have ${info.used_chars} chars; the ceiling for ${resolved.relPath} is ${limit}.`,
            resolved.kind === 'user'
              ? 'USER.md is never consolidated automatically: ask the owner of this memory to trim the file.'
              : 'Consolidate IN THIS turn: remove/merge entries (memory_remove with demote) and retry the batch together.',
            {
              current_entries: entriesPayload(state.sections),
              demotion_candidates: demotion,
              over_by_chars: info.used_chars - limit,
              attempt,
              attemptsLeft: resolved.kind === 'user' ? 0 : Math.max(0, 3 - attempt),
              final: resolved.kind === 'user',
            });
        }
        // Attempt 3: forced, deterministic consolidation; never another error.
        const finalSections = parseSections(final);
        const candidates = finalSections.flatMap((s) => s.entries.map((e) => ({ s, e })))
          .sort((a, b) => {
            const originRank = (x: Entry): number => {
              const p = parseBulletSrc(x.text);
              return p?.origin === 'human_direct' ? 2 : p?.origin === 'session_extract' ? 1 : 0;
            };
            // Weakest first; tie: longest first.
            return originRank(a.e) - originRank(b.e) || (b.e.text.length - a.e.text.length);
          });
        for (const { e } of candidates) {
          if (budgetInfo(final, resolved.kind).used_chars <= limit) break;
          const idx = final.indexOf(e.text);
          if (idx === -1) continue;
          final = final.slice(0, idx) + final.slice(Math.min(idx + e.text.length + 1, final.length));
          archiveLines.push(`- ${stripComments(e.text).trim()} <!-- demoted ${new Date().toISOString().slice(0, 10)} (forceConsolidate) -->`);
        }
        final = canonicalize(final);
        consolidated = true;
        info = budgetInfo(final, resolved.kind);
      }
    }

    // 10. Atomic write with backup, preserving the file's EOL.
    const backupPath = backupBeforeWrite(resolved.vaultRoot, resolved.relPath);
    await atomicWriteMarkdown(resolved.absPath, applyEol(final, state.eol));
    attempts.delete(attemptKey);

    if (archiveLines.length > 0) {
      const archiveRel = resolved.relPath.replace(/\.md$/, '-archive.md');
      const archiveAbs = path.join(resolved.vaultRoot, archiveRel);
      const existing = fs.existsSync(archiveAbs) ? fs.readFileSync(archiveAbs, 'utf8') : `# ${archiveRel}\n`;
      backupBeforeWrite(resolved.vaultRoot, archiveRel);
      await atomicWriteMarkdown(archiveAbs, canonicalize(existing + '\n' + archiveLines.join('\n') + '\n'));
    }

    const newState = readState(resolved.absPath, resolved.vaultName);
    // One record for both stores, so the durable JSONL and the SQLite projection
    // never disagree. The durable file (kept under the vault's .memory/) is the
    // truth `memory log` reads; the SQLite row is only a fast projection that a
    // reset/uninstall may rebuild.
    // The claimed provenance of each op, so the audit trail can show a line was
    // smuggled in claiming source:'user' (an omitted source is 'inferred', the
    // pipeline default). This is a DISPLAY/audit field: it never gates a write —
    // the injection scan and the auto-section gate key on `actor`, not this.
    const sources = [...new Set(params.ops.map((o) => o.source ?? 'inferred'))].join(',');
    const entry: WriteLogEntry = {
      ts: Date.now(),
      vault: resolved.vaultName,
      path: resolved.relPath,
      op: params.ops.map((o) => o.op).join(','),
      section: opSections.join(','),
      before_hash: state.fileHash,
      after_hash: newState.fileHash,
      backup_path: backupPath ?? null,
      actor: params.actor ?? 'mcp',
      source: sources,
      session_id: params.session_id ?? null,
      client: sanitizeClientName(params.client) ?? null,
    };
    appendWriteLog(resolved.vaultRoot, entry);
    deps.db.prepare(`
      INSERT INTO write_log (ts, vault, path, op, section, before_hash, after_hash, backup_path, actor, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entry.ts, entry.vault, entry.path, entry.op,
      entry.section, entry.before_hash, entry.after_hash, entry.backup_path,
      entry.actor, entry.session_id);

    // Reindex immediately: search sees the write without waiting for the watcher.
    const ctx = deps.indexerCtxFor(resolved.vaultName);
    if (ctx) indexFile(ctx, resolved.relPath);

    return {
      file: params.file,
      path_hint: `${resolved.vaultName}:${resolved.relPath}`,
      new_hash: currentHashes(newState),
      budget: budgetInfo(newState.canonical, resolved.kind),
      applied,
      skipped: [],
      consolidated,
      visible_next_session: true,
    };
  });
}

// ---------- daily_append ----------

export interface DailyParams {
  text: string;
  kind?: 'fact' | 'decision' | 'pending' | 'waiting' | undefined;
  date?: string | undefined;
  tags?: string[] | undefined;
  /**
   * Caller's vault (the proxy injects it; the model never sends a path). Absent
   * means the caller could not resolve one, and the day line falls back to
   * `global` — see the fail-closed note in runDaily.
   */
  vault?: string | undefined;
  /** Connecting app's display name (audit log only; never a security signal). */
  client?: string | undefined;
}

/**
 * The vault name a CLIENT should send for a `daily_append`, resolved from its
 * own config exactly as `resolveTargetVault` does for the curated files.
 *
 * The day file used to be pinned to `global` whatever repo the caller ran in.
 * That was the last body of agent-written text crossing the vault boundary, and
 * `docs/agent-guide.md` points agents at `daily_append` for anything taken from a
 * meeting, a document or a tool result — exactly the content most likely to
 * belong to a client. So the day line follows the repo marker like every other
 * write: one rule, no exception.
 *
 * It used to degrade to `global` when the marker could not be honoured. That is
 * no longer safe: the shared vault needs an invitation now, and a repo that
 * cannot even name its own vault has not given one. So this refuses, like the
 * curated files.
 */
export function resolveDailyVault(config: MemoryConfig): string {
  return resolveTargetVault(config);
}

export async function runDaily(deps: WriteDeps, params: DailyParams): Promise<Record<string, unknown>> {
  if (!params.text || params.text.length > 1000) {
    throw new ToolError('BAD_REQUEST', 'text is required, up to 1000 chars.', 'Shorten the line.');
  }
  const finding = scanSecrets(params.text)[0];
  if (finding) {
    throw new ToolError('SECRET_BLOCKED', `Secret detected (${finding.rule}).`,
      'Remove the sensitive value; the daily goes to Git.');
  }
  // The client denylist, same rule and same wording as the curated layer. It was
  // missing here, and that made `daily_append` a way around it: an agent refused
  // by memory_add could put the same term in the day file with the next call.
  // The gate belongs on both, whatever vault the file ends up in.
  const denied = checkDenylist(params.text);
  if (denied) {
    throw new ToolError('DENYLIST_BLOCKED', 'The text contains a term from the client denylist.',
      'Rewrite without naming the client; the denylist protects the Git repo.', { term_length: denied.length });
  }
  // The vault the CALLER resolved from its own repo marker. The daemon cannot
  // resolve it: it is one shared process, so its own config carries the marker of
  // whatever repo started it. An absent name (an older client, or a path with no
  // repo context) and a name no longer in the config used to fall back to the
  // shared vault. That fallback is gone: the shared vault is now a private vault
  // like any other, and writing a client's day line into it without an invitation
  // is exactly the leak this system prevents. Fail closed instead.
  const vaultName = params.vault;
  const vaultRoot = vaultName ? deps.config.vaults[vaultName] : undefined;
  if (!vaultName || !vaultRoot) {
    throw new ToolError('VAULT_UNRESOLVED',
      'This day line has no vault to go to: the caller did not resolve one, or the vault it named is no '
      + 'longer configured.',
      'Run from a folder whose .memory.yml names a configured vault, or from a folder with no marker so '
      + 'the default vault is used. Check the list with: memory vault list',
      { requested_vault: vaultName ?? null });
  }

  const date = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
    ? params.date
    : new Date().toISOString().slice(0, 10);
  const relPath = `daily/${date}.md`;
  const absPath = path.join(vaultRoot, relPath);
  const tags = (params.tags ?? []).map((t) => `#${t.replace(/^#/, '')}`).join(' ');
  const line = `- ${params.kind ?? 'fact'}: ${params.text}${tags ? ' ' + tags : ''}`;

  // Append-only serialized by the daemon: no hash precondition (section 5).
  return enqueue(absPath.toLowerCase(), async () => {
    const created = !fs.existsSync(absPath);
    const existing = created ? `# ${date}\n` : fs.readFileSync(absPath, 'utf8');
    // atomicWriteMarkdown creates the parent folder, so a vault that never held
    // a day file gets its `daily/` on the first line, with no manual setup.
    await atomicWriteMarkdown(absPath, canonicalize(existing + '\n' + line + '\n'));
    // The index context, the durable log and the SQLite row all key on the SAME
    // vault as the file. A mismatch would make the line searchable from the
    // wrong vault, or audit it against a vault it never touched.
    const ctx = deps.indexerCtxFor(vaultName);
    if (ctx) indexFile(ctx, relPath);
    // Durable audit record first (the truth), then the SQLite projection.
    const entry: WriteLogEntry = {
      ts: Date.now(), vault: vaultName, path: relPath, op: 'daily_append',
      section: null, before_hash: null, after_hash: null, backup_path: null,
      actor: 'mcp', source: null, session_id: null, client: sanitizeClientName(params.client) ?? null,
    };
    appendWriteLog(vaultRoot, entry);
    deps.db.prepare(`
      INSERT INTO write_log (ts, vault, path, op, section, before_hash, after_hash, backup_path, actor, session_id)
      VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL)
    `).run(entry.ts, entry.vault, entry.path, entry.op, entry.actor);
    return { path_hint: `${vaultName}:${relPath}`, line, created_file: created };
  });
}

// ---------- frozen snapshot ----------

export interface SnapshotParams {
  session_id?: string | undefined;
  source?: string | undefined;
  vault?: string | undefined;
  /** Caller repo's cwd: feeds the retrieval push (Increment 5). */
  cwd?: string | undefined;
}

/**
 * Briefing body: the curated files of every vault this session may READ, with no
 * comments and nothing volatile.
 *
 * It follows the same readable set as a search, so the briefing can never show
 * more than the agent could find on its own. In practice that is the session's
 * own vault, plus the shared vault only when the repo opted in with
 * `share_global: true`. A marker that could not be honoured yields an empty
 * briefing, which is the honest answer: there is no vault to brief from.
 *
 * Every block is labelled with its vault (`USER:acme`), because two vaults can
 * now contribute a file with the same name.
 */
export function buildSnapshotBody(config: MemoryConfig, scope?: ReadScope): string {
  const parts: string[] = [];
  const push = (label: string, absPath: string): void => {
    if (!fs.existsSync(absPath)) return;
    const body = stripComments(canonicalize(fs.readFileSync(absPath, 'utf8')))
      .replace(/^---\n[\s\S]*?\n---\n?/, '')
      .trim();
    if (body) parts.push(`<!-- ${label} -->\n${body}`);
  };
  const use = scope ?? ambientReadScope(config);
  // Never 'all' and never undefined here, so the list is always exact.
  const vaults = readableVaults(config, use.vault, use.shareGlobal) ?? [];
  for (const name of vaults) {
    const root = config.vaults[name];
    if (!root) continue;
    for (const file of ['USER', 'MEMORY', 'PROJECT'] as const) {
      push(`${file}:${name}`, path.join(root, `${file}.md`));
    }
  }
  return parts.join('\n\n');
}

/**
 * The vault ONE session may READ from, resolved from the repo it runs in, or
 * null when its marker could not be honoured. It feeds the frozen snapshot, the
 * retrieval push and the capture triage context; it never decides where a write
 * lands (that is resolveMemoryFile).
 *
 * The SessionStart hook may only use net + JSON (the hook-bundle test enforces
 * it), so it sends its cwd and the daemon resolves the marker here. Without this
 * the snapshot and the retrieval push used the DAEMON's default vault — the
 * vault of whatever repo happened to start the daemon — which in a multi-vault
 * setup is another tenant's vault.
 *
 * Order: an explicit vault on the request, then the repo's `.memory.yml` marker,
 * then this process's ambient vault.
 */
export function resolveSessionVault(
  config: MemoryConfig,
  cwd?: string | undefined,
  explicit?: string | undefined,
): string | null {
  return resolveSessionScope(config, cwd, explicit).vault;
}

/** A session's read scope, plus the marker details when the marker is the problem. */
export interface SessionScope extends ReadScope {
  broken?: MarkerProblem | undefined;
}

/**
 * The same resolution, plus the marker details when the marker is the reason
 * there is no vault. The daemon needs them to explain a refusal: its OWN config
 * describes the repo that started it, so `config.markerFile` there is about the
 * wrong repo. Only a caller that sent a cwd can be told precisely which file to
 * fix.
 */
export function resolveSessionScope(
  config: MemoryConfig,
  cwd?: string | undefined,
  explicit?: string | undefined,
): SessionScope {
  // An explicit vault comes from a trusted caller (the CLI, or a test). It names
  // one vault and asks for no sharing: the invitation lives in the marker only.
  if (explicit) return { vault: explicit, shareGlobal: false };
  if (cwd) {
    const marker = readProjectMarker(cwd);
    // A marker naming a configured vault is the session's vault, and it also
    // carries whether that repo invited the shared vault in.
    if (marker.kind === 'named' && config.vaults[marker.vault]) {
      return { vault: marker.vault, shareGlobal: marker.shareGlobal };
    }
    // A marker that EXISTS but cannot be honoured (a typo, a vault removed from
    // config, broken YAML) means we do not know whose repo this session is in.
    // Falling back to any vault would hand it memory that was never meant for
    // it, so the session reads nothing. The mismatch is not silent: loadConfig
    // also raises config.markerWarning for it.
    if (marker.kind === 'named') {
      return { vault: null, shareGlobal: false, broken: { markerFile: marker.file, markerVault: marker.vault } };
    }
    if (marker.kind === 'malformed') {
      return { vault: null, shareGlobal: false, broken: { markerFile: marker.file } };
    }
  }
  // No marker at all (or no cwd): the repo has no vault of its own, so the
  // process's ambient scope is the honest answer. It is the config default,
  // and the same vault this repo's writes already go to.
  return ambientReadScope(config);
}

export async function runSnapshot(deps: WriteDeps, params: SnapshotParams): Promise<Record<string, unknown>> {
  if (params.session_id) {
    const row = deps.db.prepare('SELECT body, sha256 FROM session_snapshot WHERE session_id = ?')
      .get(params.session_id) as { body: string; sha256: string } | undefined;
    // Frozen: the same session_id returns THE SAME BYTES, always.
    if (row) return { body: row.body, sha256: row.sha256, frozen: true };
  }
  // One scope for the whole briefing: the curated files that are included and
  // the memories the push retrieves must come from the SAME readable set.
  const scope = resolveSessionScope(deps.config, params.cwd, params.vault);
  // The push enters the SAME block as the snapshot and freezes with it (prefix cache).
  let body = buildSnapshotBody(deps.config, scope);
  if (deps.buildPush) {
    const push = await deps.buildPush(params.cwd, scope).catch(() => '');
    if (push) body = body ? `${body}\n\n${push}` : push;
  }
  const hash = sha256(body);
  if (params.session_id) {
    deps.db.prepare(`
      INSERT OR IGNORE INTO session_snapshot (session_id, created_at, body, sha256, char_count, source_first)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(params.session_id, new Date().toISOString().slice(0, 10), body, hash, [...body].length, params.source ?? 'startup');
  }
  return { body, sha256: hash, frozen: false };
}

// ---------- purge sessions (memory forget --purge-sessions) ----------

export interface PurgeSessionsParams {
  /** The wording to scrub from the redacted session transcripts. */
  query: string;
}

export interface PurgeSessionsData {
  scannedFiles: number;
  changedFiles: Array<{ path: string; purgedLines: number }>;
  totalPurgedLines: number;
}

/** The token a purged line becomes; also the skip-guard so a re-run is a no-op. */
const PURGE_MARKER = '[PURGED]';

/**
 * Scrubs every line that contains `query` from the redacted session transcripts
 * (sessions/*.md) of EVERY configured vault, replacing each matching line with a
 * `[PURGED]` marker. `memory forget` removes a curated entry but leaves copies
 * in these transcripts; this reaches those copies. Scope is sessions/ ONLY —
 * never any other folder. Each changed file is rewritten atomically (backup +
 * tmp+fsync+rename) through the daemon (the single writer), re-indexed so search
 * stops returning the text, and recorded in the durable write log. Git history
 * is out of scope on purpose; the CLI states that in plain words.
 *
 * Every vault, not only `global`: a session transcript is written into the vault
 * of the repo the session ran in, so scanning `global` alone would report
 * "scrubbed 0 lines" while the wording was still on disk in a client vault. That
 * turns a privacy command into a false statement. Reading across vaults is safe
 * here because this path is human-only: it is reachable through `memory forget
 * --purge-sessions` at the terminal (actor `user_cli`), never through an MCP
 * tool, and the person owns all of their own vaults.
 */
export async function runPurgeSessions(deps: WriteDeps, params: PurgeSessionsParams): Promise<PurgeSessionsData> {
  const query = (params.query ?? '').trim();
  // Guard the minimum length so a stray short string cannot blank whole files.
  if (query.length < 3) {
    throw new ToolError('BAD_REQUEST', 'The purge query needs at least 3 characters.',
      'Pass the exact wording to scrub from the session transcripts.');
  }
  const vaults = Object.entries(deps.config.vaults);
  if (vaults.length === 0) {
    throw new ToolError('FILE_NOT_FOUND', 'No vault is configured.', 'Check config.yml.');
  }

  const needle = normalizeForMatch(query);
  const changedFiles: Array<{ path: string; purgedLines: number }> = [];
  let scannedFiles = 0;
  let totalPurgedLines = 0;

  for (const [vaultName, vaultRoot] of vaults) {
    const sessionsDir = path.join(vaultRoot, 'sessions');
    // A vault with no sessions folder simply has nothing to scrub.
    if (!fs.existsSync(sessionsDir)) continue;
    const files = fs.readdirSync(sessionsDir).filter((f) => f.toLowerCase().endsWith('.md'));
    scannedFiles += files.length;

    for (const name of files) {
      const relPath = `sessions/${name}`;
      const absPath = path.join(sessionsDir, name);
      // Serialize through the pipeline's per-file queue, so a concurrent write to
      // the same transcript never interleaves with this rewrite.
      const purgedLines = await enqueue(absPath.toLowerCase(), async (): Promise<number> => {
        let raw = '';
        try {
          raw = fs.readFileSync(absPath, 'utf8');
        } catch {
          return 0; // a file that vanished between readdir and open is simply skipped
        }
        const eol = detectEol(raw);
        const lines = canonicalize(raw).split('\n');
        let count = 0;
        const out = lines.map((line) => {
          // Replace the WHOLE matching line, not just the substring: a partial
          // wipe could leave a revealing sentence fragment behind. Already-purged
          // lines are left as-is so a re-run does not keep counting them.
          if (line !== PURGE_MARKER && normalizeForMatch(line).includes(needle)) {
            count++;
            return PURGE_MARKER;
          }
          return line;
        });
        if (count === 0) return 0;
        backupBeforeWrite(vaultRoot, relPath);
        await atomicWriteMarkdown(absPath, applyEol(canonicalize(out.join('\n')), eol));
        // Re-index so the scrubbed text disappears from search immediately.
        const ctx = deps.indexerCtxFor(vaultName);
        if (ctx) indexFile(ctx, relPath);
        // Audit the scrub in the durable log, like any other content write. The
        // log lives under the vault that was changed, so each vault keeps its
        // own trail.
        const entry: WriteLogEntry = {
          ts: Date.now(), vault: vaultName, path: relPath, op: 'purge_sessions',
          section: null, before_hash: null, after_hash: null, backup_path: null,
          actor: 'user_cli', source: null, session_id: null, client: null,
        };
        appendWriteLog(vaultRoot, entry);
        return count;
      });
      if (purgedLines > 0) {
        changedFiles.push({ path: `${vaultName}:${relPath}`, purgedLines });
        totalPurgedLines += purgedLines;
      }
    }
  }
  return { scannedFiles, changedFiles, totalPurgedLines };
}
