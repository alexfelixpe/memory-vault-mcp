import { describe, it, expect } from 'vitest';
import { runTriage, type ChatFn } from '../../src/daemon/capture/extractor.js';
import type { DeltaTurn } from '../../src/daemon/capture/read-delta.js';

/**
 * Security finding #3: the triage payload sent to OpenRouter must be redacted
 * and stripped of third-party tool output before it leaves the machine, so it
 * matches the protection of the local sessions/ copy. These tests drive
 * runTriage with a fake ChatFn that captures the exact body it is asked to send
 * and assert the raw secret and the tool_result content never appear in it.
 */

/** A fake transport that records the body instead of sending it over the network. */
function capturingChat(): { chat: ChatFn; body: () => string } {
  let seen: unknown;
  const chat: ChatFn = async (body) => {
    seen = body;
    // A valid empty triage result so the pass completes without proposing items.
    return { choices: [{ message: { tool_calls: [{ function: { arguments: '{"nothing_to_save":true,"items":[]}' } }] } }] };
  };
  return { chat, body: () => JSON.stringify(seen) };
}

const turn = (n: number, role: DeltaTurn['role'], text: string): DeltaTurn => ({
  n,
  role,
  origin: role === 'user' ? 'session_extract' : 'third_party_derived',
  text,
  uuid: `u${n}`,
});

describe('capture egress redaction (finding #3)', () => {
  it('a known secret never appears in the outbound triage body', async () => {
    const { chat, body } = capturingChat();
    const turns = [
      turn(0, 'user', 'Use this key sk-ant-EXAMPLE0123456789abcdef to reach the API'),
      turn(1, 'user', 'my api_key = xK9mQ2vL8pR4tW7zZZ never save this'),
    ];

    await runTriage(chat, 'fake-model', turns, []);

    const sent = body();
    expect(sent).not.toContain('sk-ant-EXAMPLE0123456789abcdef');
    expect(sent).not.toContain('xK9mQ2vL8pR4tW7zZZ');
    expect(sent).toContain('[REDACTED:secret.anthropic]');
    expect(sent).toContain('[REDACTED:secret.assignment]');
  });

  it('a secret in a curated entry never appears in the outbound triage body', async () => {
    const { chat, body } = capturingChat();
    // A benign user turn plus curated bodies pulled from USER.md/MEMORY.md that
    // happen to carry a secret; the curated inline must be redacted like the transcript.
    const turns = [turn(0, 'user', 'I prefer squash merges on the main branch')];
    const curated = [
      'The user uses sk-ant-EXAMPLE0123456789abcdef for the internal API',
      'deploy secret: api_key = xK9mQ2vL8pR4tW7zZZ',
    ];

    await runTriage(chat, 'fake-model', turns, curated);

    const sent = body();
    expect(sent).not.toContain('sk-ant-EXAMPLE0123456789abcdef');
    expect(sent).not.toContain('xK9mQ2vL8pR4tW7zZZ');
    expect(sent).toContain('[REDACTED:secret.anthropic]');
    expect(sent).toContain('[REDACTED:secret.assignment]');
  });

  it('tool_result content never leaves the machine', async () => {
    const { chat, body } = capturingChat();
    const marker = 'UNIQUE_TOOL_MARKER_9f2a';
    const turns = [
      turn(0, 'user', 'I prefer squash merges on the main branch'),
      turn(1, 'tool_result', `customer record ${marker} returned by an internal tool`),
    ];

    await runTriage(chat, 'fake-model', turns, []);

    const sent = body();
    expect(sent).not.toContain(marker);
    // The legitimate user turn still reaches the model.
    expect(sent).toContain('squash merges');
  });
});
