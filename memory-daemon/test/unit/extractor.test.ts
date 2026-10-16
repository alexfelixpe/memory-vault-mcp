import { describe, it, expect } from 'vitest';
import {
  runTriage, buildCliPrompt, parseCliResult, isAuthFailureText, type ChatFn,
} from '../../src/daemon/capture/extractor.js';
import type { DeltaTurn } from '../../src/daemon/capture/read-delta.js';

/**
 * The overflow guard: a model that ignores the 10-item cap must not kill the
 * whole pass, because a failed pass keeps the watermark and retries the SAME
 * window forever (seen live on 2026-07-28, openai/gpt-oss-120b returned >10).
 */

/** A transport that answers with a fixed emit_triage payload. */
const chatReturning = (payload: unknown): ChatFn => async () => ({
  choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(payload) } }] } }],
});

const turn = (n: number): DeltaTurn => ({
  n, role: 'user', origin: 'session_extract', text: `turn ${n}`, uuid: `u${n}`,
});

const item = (n: number): Record<string, unknown> => ({
  text: `The user prefers convention number ${n} for this project`,
  class: 'style_preference',
  target: 'user',
  section: 'Preferences',
  confidence: 0.9,
  source_turn: 0,
  duplicate: false,
  evidence: `said in turn ${n}`,
});

describe('runTriage item-count overflow', () => {
  it('an over-long item list is truncated to the cap, not a failed pass', async () => {
    const payload = { nothing_to_save: false, items: Array.from({ length: 14 }, (_, i) => item(i)) };
    const items = await runTriage(chatReturning(payload), 'fake-model', [turn(0)], []);
    expect(items).toHaveLength(10);
  });

  it('a malformed item still fails the pass: only the count is forgiven', async () => {
    const payload = { nothing_to_save: false, items: [{ ...item(0), confidence: 3 }] };
    await expect(runTriage(chatReturning(payload), 'fake-model', [turn(0)], [])).rejects.toThrow();
  });
});

describe('claude CLI transport helpers', () => {
  it('buildCliPrompt carries the system text and inlines the tool schema for the user', () => {
    const body = {
      messages: [
        { role: 'system', content: 'You are a triager.' },
        { role: 'user', content: 'Session excerpt: hello' },
      ],
      tools: [{ function: { parameters: { type: 'object', required: ['items'] } } }],
    };
    const { system, user } = buildCliPrompt(body);
    expect(system).toBe('You are a triager.');
    expect(user).toContain('Session excerpt: hello');
    expect(user).toContain('"required":["items"]');
    expect(user).toContain('ONLY one JSON object');
  });

  it('parseCliResult unwraps a fenced JSON answer into the tool-call shape', () => {
    const wrapper = JSON.stringify({
      type: 'result', is_error: false,
      result: 'Here you go:\n```json\n{"nothing_to_save":true,"items":[]}\n```\n',
    });
    const res = parseCliResult(wrapper) as {
      choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }>;
    };
    const args = JSON.parse(res.choices[0]!.message.tool_calls[0]!.function.arguments);
    expect(args).toEqual({ nothing_to_save: true, items: [] });
  });

  it('parseCliResult fails loudly on an error wrapper and on a result with no JSON', () => {
    expect(() => parseCliResult(JSON.stringify({ is_error: true, subtype: 'error_during_execution' })))
      .toThrow(/error result/);
    expect(() => parseCliResult(JSON.stringify({ is_error: false, result: 'no json here' })))
      .toThrow(/no JSON object/);
  });

  it('recognizes the wordings of a logged-out CLI, and not ordinary failures', () => {
    expect(isAuthFailureText('Invalid API key · Please run /login')).toBe(true);
    expect(isAuthFailureText('OAuth token has expired')).toBe(true);
    expect(isAuthFailureText('claude CLI exited 1: not logged in')).toBe(true);
    expect(isAuthFailureText('claude CLI timed out after 120 s')).toBe(false);
    expect(isAuthFailureText('spawn ENOENT')).toBe(false);
  });
});
