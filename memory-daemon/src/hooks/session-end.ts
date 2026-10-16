#!/usr/bin/env node
import { DaemonClient } from '../mcp/client.js';

/**
 * SessionEnd hook: requests a best-effort flush of the capture. It is NEVER
 * the primary path (the survival of a detached child process on Windows is
 * not guaranteed); the idempotent watermark is what protects the data.
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const input = JSON.parse(await readStdin()) as { session_id?: string; transcript_path?: string; cwd?: string };
  if (!input.session_id || !input.transcript_path) return;
  // No spawn: if the daemon is not alive at session end, it is not worth starting one.
  const client = new DaemonClient({ spawnCommand: false, connectWindowMs: 1_500, requestTimeoutMs: 2_000 });
  try {
    await client.request('capture.flush', {
      session_id: input.session_id,
      transcript_path: input.transcript_path,
      // Same reason as the Stop hook: the flush runs the same triage pass, so
      // it must carry the session's repo for the vault to be resolved from.
      cwd: input.cwd,
    });
  } finally {
    client.close();
  }
}

main().catch(() => { /* silent by contract */ }).finally(() => process.exit(0));
