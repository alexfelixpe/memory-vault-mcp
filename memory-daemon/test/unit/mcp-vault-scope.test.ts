import { describe, it, expect } from 'vitest';
import { registerTools, type ToolDeps } from '../../src/mcp/tools.js';
import type { MemoryConfig } from '../../src/core/config.js';

/**
 * Vault read isolation depends on the daemon deciding the readable set from ONE
 * field the proxy controls. This pins that half of the contract, the same way
 * mcp-actor.test.ts pins `actor`: the memory_search schema has no vault or scope
 * field for the model to fill, and the proxy writes `vault` LAST, so an agent
 * cannot name another client's vault or ask for every vault.
 */

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
interface ToolConfig { inputSchema: Record<string, unknown> }

const config: MemoryConfig = {
  vaults: { global: '/tmp/global', clientA: '/tmp/a', clientB: '/tmp/b' },
  defaultVault: 'clientA',
  embeddings: { enabled: false, model: 'x' },
};

/** Registers the tools against fakes and returns what was captured. */
function setup() {
  const handlers = new Map<string, ToolHandler>();
  const configs = new Map<string, ToolConfig>();
  const fakeServer = {
    registerTool: (name: string, cfg: ToolConfig, handler: ToolHandler) => {
      handlers.set(name, handler);
      configs.set(name, cfg);
    },
  };
  let captured: { method: string; params: Record<string, unknown> } | undefined;
  const fakeClient = {
    request: (method: string, params: Record<string, unknown>) => {
      captured = { method, params };
      return Promise.resolve({ query_kind: 'natural', hits: [] });
    },
    close: () => { /* nothing to close in the fake */ },
  };
  const deps: ToolDeps = {
    getConfig: () => config,
    getDb: () => { throw new Error('the offline fallback is not exercised in this test'); },
    client: fakeClient as unknown as ToolDeps['client'],
  };
  registerTools(fakeServer as unknown as Parameters<typeof registerTools>[0], deps);
  return { handlers, configs, get captured() { return captured; } };
}

describe('MCP search proxy stamps a non-spoofable vault', () => {
  it('the memory_search schema offers the model no vault or scope-widening field', () => {
    const { configs } = setup();
    const shape = configs.get('memory_search')!.inputSchema;
    expect(Object.keys(shape)).toEqual(['query', 'k', 'scope', 'filters', 'mode', 'cursor', 'expand']);
    expect(shape['vault']).toBeUndefined();
    expect(shape['vaults']).toBeUndefined();
    // `scope` exists but selects a LAYER (curated, meetings, ...), never a vault.
    expect(Object.keys(shape)).not.toContain('all_vaults');
  });

  it('overwrites a vault the agent tried to smuggle in with the resolved one', async () => {
    const ctx = setup();
    await ctx.handlers.get('memory_search')!({ query: 'what did we decide', vault: 'clientB' });
    expect(ctx.captured?.method).toBe('search');
    expect(ctx.captured?.params['vault']).toBe('clientA');
    expect(ctx.captured?.params['vault']).not.toBe('clientB');
  });

  it('an agent cannot ask for every vault by sending the human "all" sentinel', async () => {
    const ctx = setup();
    await ctx.handlers.get('memory_search')!({ query: 'what did we decide', vault: 'all' });
    expect(ctx.captured?.params['vault']).toBe('clientA');
  });

  it('a plain call carries the resolved vault, so the daemon always has one to scope by', async () => {
    const ctx = setup();
    await ctx.handlers.get('memory_search')!({ query: 'what did we decide' });
    expect(ctx.captured?.params['vault']).toBe('clientA');
    expect(ctx.captured?.params['query']).toBe('what did we decide');
  });
});
