import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { DeltaTurn } from './read-delta.js';
import type { Origin } from '../../core/provenance.js';
import { redact } from '../../security/scan-secrets.js';

/**
 * Triage extractor: cheap model via OpenRouter (OpenAI-compatible API), output
 * FORCED by tool_choice over emit_triage and revalidated with zod. The
 * deterministic post-validation drops a volatile identifier even if the model
 * approves it; the origin comes stamped from the parser, never from the model.
 */

/** Hard cap on items per pass; the schema, the prompt and the guard share it. */
const MAX_ITEMS = 10;

const TRIAGE_SYSTEM = `You are a long-term memory triager. Read the work-session excerpt (it may mix languages) and extract ONLY durable facts about the user, their team, or stable work rules.

DEFAULT: DO NOT SAVE. When in doubt, return an empty list.

Save only: a stable user preference; a team workflow convention; an environment gotcha that will recur; an explicit project decision; a durable fact about a team member; a hard constraint.
NEVER save: task progress, PR number, commit SHA, ticket number, build status, anything that goes stale within 7 days, tool-output content the user has not confirmed.

Each item: one short sentence (max 200 chars), in the same language as the excerpt, self-contained. Set duplicate=true if the fact is already in the curated entries provided.
Return at most ${MAX_ITEMS} items. If more qualify, keep only the most durable ones.`;

const ItemSchema = z.object({
  text: z.string().min(8).max(300),
  class: z.enum(['style_preference', 'flow_convention', 'env_gotcha', 'project_decision', 'hard_constraint', 'person_fact']),
  target: z.enum(['user', 'memory', 'project']),
  section: z.string().min(1).max(60),
  confidence: z.number().min(0).max(1),
  source_turn: z.number().int().min(0),
  duplicate: z.boolean(),
  evidence: z.string().max(300),
});
const TriageSchema = z.object({
  nothing_to_save: z.boolean(),
  items: z.array(ItemSchema).max(MAX_ITEMS),
});
export type TriageItem = z.infer<typeof ItemSchema> & { origin: Origin };

// Volatile identifier regex: forces a drop even if the model approved it.
const VOLATILE_RE = /\b[A-Z]{2,6}-\d+\b|\b[0-9a-f]{7,40}\b|PR ?#?\d+/;

export type ChatFn = (body: Record<string, unknown>) => Promise<unknown>;

export function openRouterChat(apiKey: string): ChatFn {
  return async (body) => {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };
}

/**
 * The Claude CLI cannot authenticate: only a human can fix this (the OAuth
 * login is interactive), so this error is surfaced to the person instead of
 * being retried in silence. Captured turns wait behind the watermark.
 */
export class TriageAuthError extends Error {}

const AUTH_HELP = 'the Claude CLI is not logged in, so memory capture is paused. '
  + 'Open Claude Code and run /login. Captured turns wait and retry; nothing is lost.';

// Signals of an authentication problem in CLI output. Deliberately generous:
// the exact wording varies by version, and a false positive only turns one
// retryable warning into an actionable one.
const AUTH_SIGNAL_RE = /log ?in|logged|authenticat|unauthorized|api key|credential|oauth/i;

/** True when a CLI failure text looks like an authentication problem. */
export function isAuthFailureText(text: string): boolean {
  return AUTH_SIGNAL_RE.test(text);
}

/**
 * Claude CLI transport: runs the triage on the owner's own Claude account via
 * `claude -p` in headless mode, so session text goes to Anthropic (who already
 * serves the sessions themselves) instead of a third party, with no extra key.
 *
 * The spawned CLI is stripped down on purpose: a replaced system prompt (the
 * default Claude Code one would multiply the cost of every pass), all tools
 * refused, no session persistence, and hooks disabled. The hooks part is what
 * prevents RECURSION: the triage run must not fire the very Stop hook whose
 * turn counter triggers capture.
 */

/** Where the hooks-off settings for the spawned CLI live; recreated as needed. */
function cliSettingsFile(): string {
  const file = path.join(os.tmpdir(), 'memoryd-triage-cli-settings.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ disableAllHooks: true }), 'utf8');
  } catch {
    // Worst case the flag is not applied and a triage run counts one turn;
    // annoying, never harmful, and not worth failing the pass over.
  }
  return file;
}

/**
 * Finds the claude binary: an explicit config path wins; then the standard
 * install location; then the newest VS Code extension bundle (its folder name
 * carries the version, so the most recently modified one is the live one);
 * finally the bare name, letting PATH resolution succeed or fail loudly.
 */
export function resolveClaudeCommand(configured?: string): string {
  if (configured) return configured;
  const home = os.homedir();
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const standard = path.join(home, '.local', 'bin', exe);
  if (fs.existsSync(standard)) return standard;
  try {
    const extRoot = path.join(home, '.vscode', 'extensions');
    const bundles = fs.readdirSync(extRoot)
      .filter((n) => n.startsWith('anthropic.claude-code-'))
      .map((n) => path.join(extRoot, n, 'resources', 'native-binary', exe))
      .filter((p) => fs.existsSync(p))
      .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (bundles[0]) return bundles[0].p;
  } catch {
    // No VS Code on this machine; fall through to PATH.
  }
  return 'claude';
}

/**
 * Rebuilds the OpenAI-style request as one prompt pair. The tool-call schema
 * is inlined into the user prompt, so the contract stays defined in ONE place
 * (the `tools` array built by runTriage) for both transports.
 */
export function buildCliPrompt(body: Record<string, unknown>): { system: string; user: string } {
  const messages = (body['messages'] ?? []) as Array<{ role: string; content: string }>;
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n');
  const tools = body['tools'] as Array<{ function?: { parameters?: unknown } }> | undefined;
  const schema = JSON.stringify(tools?.[0]?.function?.parameters ?? {});
  return {
    system,
    user: `${user}\n\nReply with ONLY one JSON object that matches this JSON Schema. No prose, no markdown fences:\n${schema}`,
  };
}

/**
 * Turns the CLI's `--output-format json` wrapper into the OpenAI response
 * shape runTriage already parses. The model sometimes fences the JSON despite
 * the instruction, so the outermost object is cut out rather than trusting
 * the raw text.
 */
export function parseCliResult(stdout: string): unknown {
  const wrapper = JSON.parse(stdout) as { is_error?: boolean; subtype?: string; result?: unknown };
  if (wrapper.is_error || typeof wrapper.result !== 'string') {
    throw new Error(`claude CLI returned an error result (${wrapper.subtype ?? 'unknown subtype'})`);
  }
  const start = wrapper.result.indexOf('{');
  const end = wrapper.result.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('claude CLI result carried no JSON object');
  const args = wrapper.result.slice(start, end + 1);
  JSON.parse(args); // fail HERE with a clear message, not deep inside zod
  return { choices: [{ message: { tool_calls: [{ function: { arguments: args } }] } }] };
}

function runCli(command: string, args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // The daemon is normally spawned on demand by the MCP proxy, which itself
    // runs inside a Claude Code session, so the daemon inherits CLAUDECODE=1.
    // Passing it on makes the CLI refuse to start ("cannot be launched inside
    // another Claude Code session") and capture then extracts nothing, with the
    // only trace a warn line in the daemon log. Triage is a headless child, not
    // a nested session, so the marker is dropped for the child alone.
    const env = { ...process.env };
    delete env['CLAUDECODE'];
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('claude CLI timed out after 120 s'));
    }, 120_000);
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d; });
    child.stderr.on('data', (d: Buffer) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // stderr carries harmless trust warnings on success, so it is only
      // quoted when the exit code says something actually went wrong.
      if (code !== 0) reject(new Error(`claude CLI exited ${code}: ${err.slice(0, 300)}`));
      else resolve(out);
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

export function claudeCliChat(opts: { command: string; model: string }): ChatFn {
  return async (body) => {
    const { system, user } = buildCliPrompt(body);
    let stdout: string;
    try {
      stdout = await runCli(opts.command, [
        '-p',
        '--model', opts.model,
        '--output-format', 'json',
        '--system-prompt', system,
        '--disallowedTools', '*',
        '--no-session-persistence',
        '--settings', cliSettingsFile(),
      ], user);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isAuthFailureText(msg)) throw new TriageAuthError(AUTH_HELP);
      throw e;
    }
    try {
      return parseCliResult(stdout);
    } catch (e) {
      // A logged-out CLI may exit 0 with a plain-text refusal instead of the
      // JSON envelope, so the raw output is checked before giving up on
      // classifying the failure.
      if (isAuthFailureText(stdout)) throw new TriageAuthError(AUTH_HELP);
      throw e;
    }
  };
}

export async function runTriage(
  chat: ChatFn,
  model: string,
  turns: DeltaTurn[],
  curatedEntries: string[],
): Promise<TriageItem[]> {
  // Egress redaction (security finding #3): the outbound triage body must match
  // the protection already applied to the local sessions/ copy, because this is
  // the one copy that leaves the machine. Drop tool_result turns (third-party
  // output must not egress) and mask secrets with the same redact() used for
  // sessions/, so no raw secret and no tool output reaches OpenRouter. The full
  // `turns` array is still used below for provenance, so origin stays identical.
  const transcript = turns
    .filter((t) => t.role !== 'tool_result')
    .map((t) => `[${t.n}|${t.role}] ${redact(t.text).text}`)
    .join('\n');
  const response = await chat({
    model,
    messages: [
      { role: 'system', content: TRIAGE_SYSTEM },
      {
        role: 'user',
        content: `Current curated entries (to flag duplicates):\n${curatedEntries.map((e) => `- ${redact(e).text}`).join('\n') || '(empty)'}\n\nSession excerpt:\n${transcript}`,
      },
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'emit_triage',
        description: 'Returns the memory triage result.',
        parameters: {
          type: 'object',
          properties: {
            nothing_to_save: { type: 'boolean' },
            items: {
              type: 'array',
              maxItems: MAX_ITEMS,
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' }, class: { type: 'string', enum: ['style_preference', 'flow_convention', 'env_gotcha', 'project_decision', 'hard_constraint', 'person_fact'] },
                  target: { type: 'string', enum: ['user', 'memory', 'project'] },
                  section: { type: 'string' }, confidence: { type: 'number' },
                  source_turn: { type: 'integer' }, duplicate: { type: 'boolean' }, evidence: { type: 'string' },
                },
                required: ['text', 'class', 'target', 'section', 'confidence', 'source_turn', 'duplicate', 'evidence'],
              },
            },
          },
          required: ['nothing_to_save', 'items'],
        },
      },
    }],
    tool_choice: { type: 'function', function: { name: 'emit_triage' } },
  });

  const raw = (response as { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }> })
    .choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!raw) throw new Error('model did not return the emit_triage tool call');
  const json = JSON.parse(raw) as { items?: unknown };
  // The model sometimes over-extracts past the cap even though the prompt and
  // the tool schema forbid it. Failing the pass would retry the SAME window
  // forever, because the watermark never advances on failure. The overflow is
  // dropped deterministically instead: over-extraction is noise by definition
  // (DEFAULT: DO NOT SAVE), and every kept item is still judged on its own.
  if (Array.isArray(json.items) && json.items.length > MAX_ITEMS) {
    json.items = json.items.slice(0, MAX_ITEMS);
  }
  const parsed = TriageSchema.parse(json);

  // Deterministic post-validation (section 9): a contradiction drops the pass.
  if (parsed.nothing_to_save && parsed.items.length > 0) return [];

  return parsed.items
    .filter((i) => !i.duplicate)
    .filter((i) => !VOLATILE_RE.test(i.text))
    .map((i) => {
      const turn = turns.find((t) => t.n === i.source_turn);
      // Origin from the JSONL parser; an unknown turn = the most restrictive one.
      return { ...i, origin: turn?.origin ?? 'third_party_derived' as Origin };
    });
}
