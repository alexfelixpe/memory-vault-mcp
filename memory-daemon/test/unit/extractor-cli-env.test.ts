import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * The triage child's environment. The daemon is normally started on demand by
 * the MCP proxy, which runs inside a Claude Code session, so the daemon holds
 * CLAUDECODE=1. Passing it down made the CLI refuse to start as a nested
 * session and capture extracted nothing, silently, for nine days (found on
 * 2026-07-30). These cases pin the marker out of the child.
 */

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { claudeCliChat } = await import('../../src/daemon/capture/extractor.js');

/** A child that answers with the JSON envelope the real CLI returns on success. */
function fakeChild(): EventEmitter & Record<string, any> {
  const child = new EventEmitter() as EventEmitter & Record<string, any>;
  child['stdout'] = new EventEmitter();
  child['stderr'] = new EventEmitter();
  child['kill'] = () => {};
  child['stdin'] = {
    write: () => {},
    // Answer only after the prompt is written, the order the real CLI follows.
    end: () => setImmediate(() => {
      const result = JSON.stringify({ nothing_to_save: true, items: [] });
      child['stdout'].emit('data', Buffer.from(JSON.stringify({ is_error: false, result })));
      child.emit('close', 0);
    }),
  };
  return child;
}

const callChat = () => claudeCliChat({ command: 'claude', model: 'haiku' })({
  model: 'haiku', messages: [{ role: 'user', content: 'hi' }],
} as never);

/** The env handed to the single spawn call of a test. */
const spawnedEnv = (): NodeJS.ProcessEnv => spawnMock.mock.calls[0]![2].env;

let saved: string | undefined;

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild());
  saved = process.env['CLAUDECODE'];
});

afterEach(() => {
  if (saved === undefined) delete process.env['CLAUDECODE'];
  else process.env['CLAUDECODE'] = saved;
});

describe('claude CLI triage child environment', () => {
  it('drops CLAUDECODE, so the CLI does not refuse as a nested session', async () => {
    process.env['CLAUDECODE'] = '1';
    await callChat();
    expect('CLAUDECODE' in spawnedEnv()).toBe(false);
  });

  it('leaves the daemon own environment untouched', async () => {
    process.env['CLAUDECODE'] = '1';
    await callChat();
    expect(process.env['CLAUDECODE']).toBe('1');
  });

  it('passes the rest of the environment through', async () => {
    process.env['MEMORY_TEST_MARKER'] = 'kept';
    try {
      await callChat();
      expect(spawnedEnv()['MEMORY_TEST_MARKER']).toBe('kept');
    } finally {
      delete process.env['MEMORY_TEST_MARKER'];
    }
  });
});
