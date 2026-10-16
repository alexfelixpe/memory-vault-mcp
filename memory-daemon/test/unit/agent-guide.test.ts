import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The agent-guide must carry a copy-pasteable system-prompt block for a
 * non-Claude agent, and it must name the REAL MCP tools (a wrong tool name in a
 * pasted instruction silently breaks the "agent uses memory on its own" path).
 */

const GUIDE = fileURLToPath(new URL('../../../docs/agent-guide.md', import.meta.url));

describe('agent-guide system-prompt block', () => {
  it('contains a system-prompt block for a non-Claude agent naming the real tools', () => {
    const text = fs.readFileSync(GUIDE, 'utf8');

    // The section a user pastes into Cursor / a generic MCP client exists.
    expect(text).toMatch(/system prompt for a non-Claude agent/i);

    // Isolate the fenced block so the assertions are about the pasted text.
    const block = /```text\n([\s\S]*?)```/.exec(text)?.[1] ?? '';
    expect(block).not.toBe('');

    // The real tool names, exactly as registered in mcp/tools.ts.
    for (const tool of ['memory_search', 'memory_get', 'memory_add', 'daily_append']) {
      expect(block).toContain(tool);
    }
    // The load-bearing safety rules are present.
    expect(block).toContain('<untrusted-memory');
    expect(block).toMatch(/source: "user"/);
    expect(block.toLowerCase()).toContain('secret');
    // The proactive behaviors: recall at the start, save durable facts.
    expect(block.toLowerCase()).toContain('start');
  });
});
