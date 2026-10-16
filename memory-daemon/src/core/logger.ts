import pino from 'pino';

/**
 * Single logger. ALWAYS on stderr: the stdout of the MCP and the hooks is a
 * protocol channel and cannot receive logs (one log line on stdout breaks
 * the MCP handshake silently).
 */
export function createLogger(name: string): pino.Logger {
  return pino({ name, level: process.env['MEMORY_LOG_LEVEL'] ?? 'info' }, pino.destination(2));
}
