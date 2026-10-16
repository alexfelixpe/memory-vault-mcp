import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type pino from 'pino';
import type { MemoryConfig } from '../../core/config.js';
import { readableVaults, type ReadScope } from '../../core/vault-scope.js';
import { resolveSessionScope } from '../write-pipeline.js';
import { vaultPredicate } from '../../index/search/lexical.js';
import { canonicalize } from '../../core/text/canonicalize.js';
import { atomicWriteMarkdown } from '../../core/atomic-write.js';
import { redact } from '../../security/scan-secrets.js';
import { readDelta, commitWatermark, type Delta } from './read-delta.js';
import {
  runTriage, openRouterChat, claudeCliChat, resolveClaudeCommand, TriageAuthError,
  type ChatFn, type TriageItem,
} from './extractor.js';
import { scanInjection } from '../../security/scan-injection.js';

/**
 * Orchestrates the capture pass: every 10 turns (counted ONLY on Stop), reads
 * the transcript delta, writes the REDACTED copy into sessions/ inside the
 * SESSION's own vault (blocking requirement: the original value never enters the
 * vault), runs triage on the cheap model and decides each candidate. Always in
 * the background: the Stop hook never waits.
 *
 * A candidate has exactly two outcomes (owner's decision, 2026-07-28: there is no
 * review queue any more). It is either auto-promoted straight into the curated
 * layer, or it is DISCARDED. A discarded item is written nowhere: no file, no
 * SQLite row, nothing the search index can reach. It is only logged at debug
 * level, with the reason, so a developer can still see what was dropped.
 */

const TURNS_PER_PASS = 10;

export interface CaptureDeps {
  db: Database.Database;
  config: MemoryConfig;
  log: pino.Logger;
  /** Injectable transport (tests use a fake; production uses OpenRouter). */
  chat?: ChatFn | undefined;
  turnsPerPass?: number | undefined;
  /**
   * Auto-promotion (closed decision, 2026-07-21): writes straight into the
   * curated layer. Only called for a safe-class item with session_extract
   * origin and confidence >= 0.8; third parties NEVER pass here (locked in code).
   * `vault` is the SESSION's vault, so a `project` item lands in the vault of
   * the repo the session ran in, never in the daemon's own default vault.
   * The write itself goes through the single pipeline, which records it in the
   * durable write log; this pass keeps no separate record of its own.
   */
  autoWrite?: ((item: { text: string; target: string; section: string }, vault: string) => Promise<boolean>) | undefined;
}

const AUTO_CLASSES = new Set(['style_preference', 'flow_convention', 'env_gotcha']);
const AUTO_MIN_CONFIDENCE = 0.8;
// A source turn longer than this reads as pasted/quoted external content, not
// the user typing a short fact. Conservative gate for the AUTO path (finding #2).
const AUTO_MAX_SOURCE_TURN_CHARS = 2000;

export class CaptureManager {
  private running = new Set<string>();

  /** Standing auth problem; set by a TriageAuthError, cleared by a good pass. */
  private authNotice: string | undefined;
  private authNoticeShownAt = 0;

  constructor(private readonly deps: CaptureDeps) {}

  /** The standing auth problem, for `memory status`; undefined when healthy. */
  notice(): string | undefined {
    return this.authNotice;
  }

  /**
   * The same notice, throttled for the Stop hook: the hook fires every turn,
   * and a person needs to be told once, not shouted at thirty times.
   */
  hookNotice(): string | undefined {
    if (!this.authNotice) return undefined;
    if (Date.now() - this.authNoticeShownAt < 30 * 60_000) return undefined;
    this.authNoticeShownAt = Date.now();
    return this.authNotice;
  }

  private chatFn(): ChatFn | undefined {
    if (this.deps.chat) return this.deps.chat;
    const triage = this.deps.config.triage;
    if (triage?.backend === 'claude-cli') {
      return claudeCliChat({ command: resolveClaudeCommand(triage.command), model: triage.model });
    }
    if (this.deps.config.openrouter) return openRouterChat(this.deps.config.openrouter.apiKey);
    return undefined;
  }

  /**
   * Stop hook: counts the turn; on the tenth it schedules the pass and returns
   * right away. `cwd` is the session's repo, carried through so the pass can
   * resolve the session's own vault (see triageVault).
   */
  onTurn(sessionId: string, transcriptPath: string, cwd?: string | undefined): { turns: number; scheduled: boolean } {
    const row = this.deps.db.prepare(`
      INSERT INTO capture_watermark (session_id, transcript_path, head_sha256, byte_offset, turns_since_pass)
      VALUES (?, ?, '', 0, 1)
      ON CONFLICT(session_id) DO UPDATE SET turns_since_pass = turns_since_pass + 1, transcript_path = excluded.transcript_path
      RETURNING turns_since_pass
    `).get(sessionId, transcriptPath) as { turns_since_pass: number };

    const due = row.turns_since_pass >= (this.deps.turnsPerPass ?? TURNS_PER_PASS);
    if (due) setImmediate(() => void this.runPass(sessionId, transcriptPath, cwd));
    return { turns: row.turns_since_pass, scheduled: due };
  }

  /** SessionEnd: best-effort flush, never primary. */
  flush(sessionId: string, transcriptPath: string, cwd?: string | undefined): void {
    setImmediate(() => void this.runPass(sessionId, transcriptPath, cwd));
  }

  /**
   * The read scope of this pass: the curated notes that may enter the triage
   * prompt, and the vault an auto-promoted item is written to. The prompt LEAVES
   * THE MACHINE (it goes to OpenRouter), so this is an egress boundary, not a
   * convenience; the write side needs the same answer, because a captured
   * project fact belongs to the repo the session ran in.
   *
   * The daemon's own default vault must never decide it: the Stop hook can start
   * a session in any repo, so in a multi-vault setup the daemon default is very
   * likely another tenant's vault. With a cwd the repo's `.memory.yml` decides,
   * through the same resolver the snapshot uses. Without a cwd (an older hook,
   * or a payload with no cwd) we cannot tell whose repo this is, so the scope is
   * empty: the same fail-closed rule as a broken marker.
   */
  private sessionScope(cwd: string | undefined): ReadScope {
    if (!cwd) return { vault: null, shareGlobal: false };
    return resolveSessionScope(this.deps.config, cwd);
  }

  async runPass(sessionId: string, transcriptPath: string, cwd?: string | undefined): Promise<number> {
    if (this.running.has(sessionId)) return 0;
    if (!fs.existsSync(transcriptPath)) return 0;
    this.running.add(sessionId);
    try {
      const delta = readDelta(this.deps.db, sessionId, transcriptPath);
      if (delta.turns.length === 0) {
        commitWatermark(this.deps.db, sessionId, transcriptPath, delta);
        return 0;
      }

      // One scope for the whole pass: the transcript copy, the context that
      // leaves the machine and the vault an auto-promoted item lands in must all
      // agree. Resolved before the first write, because the transcript is scoped
      // by it too.
      const scope = this.sessionScope(cwd);
      // No vault at all (a marker we could not honour, or a payload with no cwd)
      // means this pass has nowhere it may write and nothing it may read. Do
      // nothing, and keep the watermark so the same delta is retried once the
      // marker is fixed. Dropping the transcript into the shared vault instead
      // would put verbatim client text in a vault this repo cannot even read.
      if (scope.vault === null) {
        this.deps.log.warn({ sessionId, cwd: cwd ?? null },
          'capture skipped: this session has no vault it may use (check the repo .memory.yml)');
        return 0;
      }
      const sessionVault = scope.vault;

      // Redacted copy BEFORE anything else: sessions/ is committed, so a masked
      // secret is a requirement, not an option.
      await this.writeRedactedSession(sessionId, delta, sessionVault);

      let written = 0;
      const chat = this.chatFn();
      if (chat) {
        // "Already known" facts for the triage prompt. This text LEAVES THE
        // MACHINE (it is sent to OpenRouter), so it must obey vault isolation
        // too: only THIS SESSION's own read scope. The daemon default is not
        // usable here — the turn hook can fire from any repo, so the default is
        // whichever repo happened to start the daemon, and using it shipped one
        // client's curated notes to a third-party API from another client's
        // session. The shared vault joins only when this repo invited it in.
        const vault = vaultPredicate(readableVaults(this.deps.config, scope.vault, scope.shareGlobal));
        const curated = (this.deps.db.prepare(
          `SELECT c.body FROM chunks c JOIN files f ON f.id = c.file_id
           WHERE f.layer = 'curated' AND f.is_deleted = 0 ${vault.sql} LIMIT 60`,
        ).all(...vault.params) as Array<{ body: string }>).map((r) => r.body.slice(0, 200));
        const model = this.deps.config.triage?.model ?? this.deps.config.openrouter?.model ?? 'openai/gpt-oss-120b';
        const items = await runTriage(chat, model, delta.turns, curated);

        // Two outcomes only: auto-promoted into the curated layer, or dropped.
        // Nothing is stored for later review, so a captured item that does not
        // qualify leaves no trace on disk or in the index.
        let discarded = 0;
        for (const item of items) {
          // The AUTO path writes into the always-injected, never-fenced curated
          // layer, so it must clear a stricter gate than the model's own class
          // and confidence (security finding #2). autoPromoteBlocked adds blocks
          // for the AUTO path only; it never widens auto-promotion, and the
          // high-precision global write-pipeline injection gate is untouched.
          const reason = this.rejectReason(item, delta);
          // A refused write (for example a 'project' item from a session whose
          // marker could not be honoured) returns false. The item is then
          // dropped rather than written somewhere else: never misrouted.
          if (reason === undefined && await this.deps.autoWrite!(item, sessionVault).catch(() => false)) {
            written++;
            continue;
          }
          discarded++;
          // Debug only, and it stays inside the log: the point is that a
          // developer can see what was dropped and why, without the item
          // accumulating anywhere a person has to review.
          this.deps.log.debug(
            { sessionId, class: item.class, origin: item.origin, confidence: item.confidence, reason: reason ?? 'write_refused', text: item.text },
            'captured item discarded: it did not qualify for auto-promotion',
          );
        }
        if (discarded > 0) this.deps.log.debug({ sessionId, discarded }, 'captured items discarded in this pass');
      } else {
        this.deps.log.info('capture without an OpenRouter key: only the redacted copy was written');
      }

      // The watermark advances ONLY after everything persists (a crash does not regress it).
      commitWatermark(this.deps.db, sessionId, transcriptPath, delta);
      this.authNotice = undefined;
      this.deps.log.info({ sessionId, turns: delta.turns.length, written }, 'capture pass completed');
      return written;
    } catch (e) {
      if (e instanceof TriageAuthError) {
        // A human problem, not a transient one: remember it so status and the
        // next Stop hook tell the person, instead of only the log file.
        this.authNotice = e.message;
        this.deps.log.error({ notice: e.message }, 'capture pass failed: the Claude CLI cannot authenticate');
      } else {
        this.deps.log.warn(e, 'capture pass failed; watermark preserved for retry');
      }
      return 0;
    } finally {
      this.running.delete(sessionId);
    }
  }

  /**
   * The single gate into the curated layer for a captured item. Returns a short
   * reason string when the item must NOT be auto-promoted, or undefined when it
   * may go in. A rejected item is discarded, so this reason is the only record
   * of it; it goes to the debug log and nowhere else.
   *
   * First the base rule (closed decision, 2026-07-21): a safe class, the
   * session_extract origin, and confidence at or above the threshold.
   * third_party_derived can never satisfy the origin check, which is how
   * "third-party content never auto-promotes" is locked in code.
   *
   * Then the extra blocks for the AUTO path only (security finding #2). The
   * curated layer is always injected into the session snapshot and is never
   * fenced, so a machine write into it must clear more than the model's
   * self-reported class and confidence. These only ADD blocks; they never widen
   * auto-promotion, and they do not touch the global write-pipeline injection
   * gate (high precision by design).
   *
   * Two families of block:
   *  - Full injection scan (all 4 rules) on the item text AND its source turn.
   *    The source turn is scanned because the triage model may paraphrase an
   *    injection OUT of the item text while the raw turn still carries it. An
   *    unknown source turn is treated as suspicious (we cannot inspect it).
   *  - Pasted/quoted-content heuristic on the source turn: a fenced code block,
   *    a markdown blockquote, or a very long single turn all suggest the user
   *    pasted attacker-authored text that would otherwise ride in as a trusted
   *    memory via the session_extract origin.
   *
   * Residual risk, accepted because auto-promotion stays ON (closed decision,
   * 2026-07-21):
   * a paraphrased instruction that matches no injection rule can STILL pass,
   * because the curated layer is not fenced and is injected verbatim. This gate
   * narrows the hole; it does not close it.
   */
  private rejectReason(item: TriageItem, delta: Delta): string | undefined {
    // No write function wired in (a daemon started without one): nothing to do.
    if (!this.deps.autoWrite) return 'no_auto_write';

    // Base eligibility. The origin check is the third-party lock.
    if (!AUTO_CLASSES.has(item.class)) return 'class_not_safe';
    if (item.origin !== 'session_extract') return 'origin_not_session_extract';
    if (item.confidence < AUTO_MIN_CONFIDENCE) return 'confidence_below_threshold';

    // The item text is what lands in curated: it must be clean.
    if (scanInjection(item.text).length > 0) return 'injection_in_item_text';

    // No matching source turn: cannot inspect the origin text, so do not risk it.
    const src = delta.turns.find((t) => t.n === item.source_turn);
    if (!src) return 'source_turn_unknown';

    // The raw source turn must be clean too (paraphrase-laundering defense).
    if (scanInjection(src.text).length > 0) return 'injection_in_source_turn';

    // Pasted/quoted external content: a fenced code block, a markdown blockquote,
    // or an unusually long single turn. Conservative on purpose.
    if (src.text.includes('```')) return 'source_turn_has_code_fence';
    if (/^> /m.test(src.text)) return 'source_turn_has_blockquote';
    if (src.text.length > AUTO_MAX_SOURCE_TURN_CHARS) return 'source_turn_too_long';

    return undefined;
  }

  /**
   * The redacted transcript copy, written into the SESSION's OWN vault.
   *
   * It used to go to `global` whatever repo the session ran in, and that was the
   * widest hole left in vault isolation: verbatim text from a session held in one
   * client's repo was searchable by an agent working in another client's repo. A
   * transcript is the largest and most detailed body of text this system keeps,
   * so it follows the same rule as every other write: the repo marker decides
   * (`resolveSessionScope`) and a repo with no marker uses the config default.
   *
   * There is no fallback vault any more. `global` is a private vault like every
   * other one now, so parking an unroutable transcript there would leak client
   * text into the personal layer. runPass refuses the whole pass before it gets
   * here when the scope has no vault; this throw covers the one race left, a
   * vault removed from the config between two passes. runPass logs it and keeps
   * the watermark, which retries the same delta on the next pass.
   *
   * The `sessions/` folder is created on demand: atomicWriteMarkdown makes the
   * parent directory, so a brand new vault needs no manual setup.
   */
  private async writeRedactedSession(sessionId: string, delta: Delta, vault: string): Promise<void> {
    const vaultRoot = this.deps.config.vaults[vault];
    if (!vaultRoot) {
      throw new Error(`No folder is configured for vault '${vault}', so the session copy has nowhere to go.`);
    }
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(vaultRoot, 'sessions', `${date}-${sessionId.slice(0, 8)}.md`);
    const header = fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8')
      : `---\ndate: ${date}\norigin: third_party_derived\ntype: session\n---\n# Session ${sessionId.slice(0, 8)}\n`;
    const lines = delta.turns
      .filter((t) => t.role !== 'tool_result') // tool output does not become a record
      .map((t) => `**${t.role}:** ${redact(t.text).text}`);
    if (lines.length === 0) return;
    await atomicWriteMarkdown(file, canonicalize(header + '\n' + lines.join('\n\n') + '\n'));
  }
}
