#!/usr/bin/env node
import { DaemonClient } from '../mcp/client.js';

/**
 * Claude Code SessionStart hook: injects the FROZEN snapshot of the curated
 * layer. Same session_id => same bytes (resume/compact do not break the
 * prefix cache). HARD RULE: this module may only use net + JSON — no
 * better-sqlite3 in the import graph (the bundle test enforces this).
 * A failure here NEVER blocks the session: it exits 0 silently.
 */

interface HookInput {
  session_id?: string;
  source?: string;
  cwd?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  let input: HookInput = {};
  try {
    input = JSON.parse(await readStdin()) as HookInput;
  } catch { /* empty or malformed stdin: continue with defaults */ }

  const client = new DaemonClient({ connectWindowMs: 8_000 });
  try {
    const snap = await client.request('snapshot', {
      session_id: input.session_id,
      source: input.source,
      cwd: input.cwd,
    });
    if (snap.body.trim() === '') return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `<personal-memory frozen="${snap.sha256.slice(0, 8)}">\n${snap.body}\n</personal-memory>`,
      },
    }));
  } finally {
    client.close();
  }
}

main().catch(() => { /* silent hook by contract */ }).finally(() => process.exit(0));
