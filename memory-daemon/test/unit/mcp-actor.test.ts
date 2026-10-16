import { describe, it, expect } from 'vitest';
import { registerTools, type ToolDeps } from '../../src/mcp/tools.js';
import type { MemoryConfig } from '../../src/core/config.js';

/**
 * The write-pipeline bypass that lets a human write into a non-auto section keys
 * on the daemon-set actor 'user_cli'. This pins the other half of that contract:
 * the MCP proxy stamps a FIXED actor (the tool name) per call path, so an agent
 * cannot smuggle actor:'user_cli' through the tool arguments to reach a
 * human-only section. Without this, keying the bypass on actor would be unsafe.
 */

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

const config: MemoryConfig = {
  vaults: { global: '/tmp/does-not-matter' }, defaultVault: 'global',
  embeddings: { enabled: false, model: 'x' },
};

describe('MCP mutate proxy stamps a non-spoofable actor', () => {
  it('overwrites a client-supplied actor with the tool name (an agent cannot become user_cli)', async () => {
    const handlers = new Map<string, ToolHandler>();
    const fakeServer = {
      registerTool: (name: string, _cfg: unknown, handler: ToolHandler) => { handlers.set(name, handler); },
    };

    let captured: { method: string; params: Record<string, unknown> } | undefined;
    const fakeClient = {
      request: (method: string, params: Record<string, unknown>) => {
        captured = { method, params };
        return Promise.resolve({ applied: [] });
      },
      close: () => { /* nothing to close in the fake */ },
    };

    const deps: ToolDeps = {
      getConfig: () => config,
      getDb: () => { throw new Error('the search path is not exercised in this test'); },
      client: fakeClient as unknown as ToolDeps['client'],
    };
    registerTools(fakeServer as unknown as Parameters<typeof registerTools>[0], deps);

    const memoryAdd = handlers.get('memory_add');
    expect(memoryAdd).toBeDefined();

    // The agent tries to smuggle actor:'user_cli' (and source:'user') to reach a
    // human-only section. The proxy sets actor LAST in the object it forwards.
    await memoryAdd!({
      file: 'memory',
      expect: { sectionHash: 'abc' },
      ops: [{ op: 'add', section: 'Profile', text: 'smuggled', source: 'user' }],
      actor: 'user_cli',
    });

    expect(captured?.method).toBe('mutate');
    expect(captured?.params['actor']).toBe('memory_add');
    expect(captured?.params['actor']).not.toBe('user_cli');

    // The agent's claimed source:'user' IS still forwarded (it is provenance),
    // but it no longer buys a bypass: the injection scan and the auto-section
    // gate key on the server-set actor above, never on this source. This is the
    // other half of the poison-hole fix — source is data, actor is authority.
    const forwardedOps = captured?.params['ops'] as Array<{ source?: string }>;
    expect(forwardedOps[0]?.source).toBe('user');
  });
});
