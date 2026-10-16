#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type Database from 'better-sqlite3';
import type { MemoryConfig } from '../core/config.js';
import { loadConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { openIndexDb } from '../index/db.js';
import { DaemonClient } from './client.js';
import { ConfigUnavailableError, registerTools } from './tools.js';

/**
 * bin memory-mcp: thin MCP proxy over stdio. Talks to the daemon through the
 * named pipe (starting the daemon on demand); if the daemon is unreachable, it
 * degrades to reading the index directly in readonly. stdout is ONLY the MCP
 * protocol.
 */

const log = createLogger('memory-mcp');

async function main(): Promise<void> {
  // Lazy config: a bad or missing config must NOT stop the handshake. The
  // server always connects; the first tool call that needs config resolves it,
  // and any failure crosses to the agent as CONFIG_UNAVAILABLE with the
  // config.ts message as the hint (same shape as the lazy getDb path below).
  // The failure is NOT cached (mirrors getDb): a config the user fixes while
  // the proxy is running self-heals on the next call.
  let config: MemoryConfig | undefined;
  const getConfig = (): MemoryConfig => {
    if (config) return config;
    try {
      config = loadConfig({ cwd: process.cwd() });
      // The marker decides which vault this agent may read, so a marker naming
      // an unknown vault must be visible somewhere. stdout is the MCP protocol,
      // so it goes to the proxy log.
      if (config.markerWarning) log.warn(config.markerWarning);
      return config;
    } catch (e) {
      throw new ConfigUnavailableError(e instanceof Error ? e.message : String(e));
    }
  };

  // Lazy open: starting the MCP without an index is not an error; the first
  // search without an index returns INDEX_UNAVAILABLE with the fix hint.
  let db: Database.Database | undefined;
  const getDb = (): Database.Database => {
    db ??= openIndexDb({ readonly: true });
    return db;
  };

  const server = new McpServer({ name: 'memory', version: '0.1.0' });
  // getClientName reads the connecting app's name from the MCP handshake
  // (clientInfo.name), populated once `initialize` completes. It is resolved
  // lazily per tool call — never at registration, which runs before connect —
  // and travels to the daemon as a write-log display label only.
  registerTools(server, {
    getConfig, getDb, client: new DaemonClient(),
    getClientName: () => server.server.getClientVersion()?.name,
  });

  await server.connect(new StdioServerTransport());
  log.info('memory-mcp connected (daemon proxy, readonly fallback)');
}

main().catch((e) => {
  log.error(e, 'memory-mcp failed to start');
  process.exit(1);
});
