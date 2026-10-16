#!/usr/bin/env node
import { DaemonClient } from '../mcp/client.js';

/**
 * Claude Code Stop hook: counts the turn (ONLY here — counting in
 * PostToolUse would turn 10 turns into 10 tool calls) and returns
 * immediately. The capture pass runs in the daemon, in the background.
 * Failure = silence, exit 0: capture must never block the session.
 *
 * HARD RULE, same as the SessionStart hook: net + JSON only. `cwd` comes
 * straight from the hook payload, so the daemon can resolve which vault this
 * session belongs to without this file reading any config.
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<number> {
  const input = JSON.parse(await readStdin()) as { session_id?: string; transcript_path?: string; cwd?: string };
  if (!input.session_id || !input.transcript_path) return 0;
  const client = new DaemonClient({ connectWindowMs: 4_000, requestTimeoutMs: 3_000 });
  try {
    const res = await client.request('capture.turn', {
      session_id: input.session_id,
      transcript_path: input.transcript_path,
      // The session's repo. Triage reads curated notes and sends them to a
      // third-party API, so it must follow THIS repo's vault, not the vault of
      // whatever repo happened to start the daemon.
      cwd: input.cwd,
    }) as { notice?: string } | undefined;
    // A standing problem only a human can fix (the CLI logged out). The hook
    // runs with asyncRewake, so exit code 2 wakes the model with this text and
    // the person is told INSIDE the session. The daemon throttles the notice,
    // so a healthy install exits 0 forever and stays silent.
    if (res?.notice) {
      console.log(`Personal memory capture problem: ${res.notice}`);
      return 2;
    }
    return 0;
  } finally {
    client.close();
  }
}

main().then((code) => process.exit(code), () => process.exit(0));
