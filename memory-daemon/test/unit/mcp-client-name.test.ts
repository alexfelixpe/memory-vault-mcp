import { describe, it, expect } from 'vitest';
import { registerTools, type ToolDeps } from '../../src/mcp/tools.js';
import type { MemoryConfig } from '../../src/core/config.js';

/**
 * The MCP proxy forwards the connecting app's name (MCP clientInfo.name) to the
 * daemon as a write-log DISPLAY label — and only that. This pins two things:
 * the label reaches the mutate/daily requests, and it is separate from `actor`
 * (the field the auto-section gate keys on), so naming an app can never bypass
 * the human-only-section protection.
 */

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

const config: MemoryConfig = {
  vaults: { global: '/tmp/does-not-matter' }, defaultVault: 'global',
  embeddings: { enabled: false, model: 'x' },
};

/** Registers the tools against a fake server/client and returns the captured request. */
function wire(getClientName: () => string | undefined): {
  handlers: Map<string, ToolHandler>;
  captured: () => { method: string; params: Record<string, unknown> } | undefined;
} {
  const handlers = new Map<string, ToolHandler>();
  const fakeServer = {
    registerTool: (name: string, _cfg: unknown, handler: ToolHandler) => { handlers.set(name, handler); },
  };
  let last: { method: string; params: Record<string, unknown> } | undefined;
  const fakeClient = {
    request: (method: string, params: Record<string, unknown>) => { last = { method, params }; return Promise.resolve({ applied: [] }); },
    close: () => { /* nothing */ },
  };
  const deps: ToolDeps = {
    getConfig: () => config,
    getDb: () => { throw new Error('search path not exercised'); },
    client: fakeClient as unknown as ToolDeps['client'],
    getClientName,
  };
  registerTools(fakeServer as unknown as Parameters<typeof registerTools>[0], deps);
  return { handlers, captured: () => last };
}

describe('MCP proxy threads the app name as an audit label', () => {
  it('sends clientInfo.name on a mutate, without touching the actor', async () => {
    const { handlers, captured } = wire(() => 'Claude Desktop');
    await handlers.get('memory_add')!({
      file: 'memory', expect: { sectionHash: 'abc' },
      ops: [{ op: 'add', section: 'Notes', text: 'hi', source: 'inferred' }],
    });
    expect(captured()?.method).toBe('mutate');
    expect(captured()?.params['client']).toBe('Claude Desktop');
    // The gate keys on actor; it stays the tool name, never user_cli.
    expect(captured()?.params['actor']).toBe('memory_add');
  });

  it('sends clientInfo.name on a daily_append', async () => {
    const { handlers, captured } = wire(() => 'Claude Code');
    await handlers.get('daily_append')!({ text: 'a line' });
    expect(captured()?.method).toBe('daily');
    expect(captured()?.params['client']).toBe('Claude Code');
  });

  it('falls back to no client label when the handshake gave no name', async () => {
    const { handlers, captured } = wire(() => undefined);
    await handlers.get('memory_add')!({
      file: 'memory', expect: { sectionHash: 'abc' },
      ops: [{ op: 'add', section: 'Notes', text: 'hi' }],
    });
    expect(captured()?.params['client']).toBeUndefined();
    expect(captured()?.params['actor']).toBe('memory_add');
  });
});
