import { runGet, runMutate, runDaily, runSnapshot, runPurgeSessions, type WriteDeps, type GetParams, type MutateParams, type DailyParams, type SnapshotParams, type PurgeSessionsParams } from '../write-pipeline.js';
import type { Handler } from '../server.js';

/**
 * Write and curated-read handlers for the pipe. Search (search/status/...)
 * stays registered in main.ts; the Increment 4 methods live here.
 */
export function writeHandlers(deps: WriteDeps): Map<string, Handler> {
  return new Map<string, Handler>([
    ['get', (params) => runGet(deps.config, params as GetParams)],
    ['mutate', (params) => runMutate(deps, params as MutateParams)],
    ['daily', (params) => runDaily(deps, params as DailyParams)],
    ['snapshot', (params) => runSnapshot(deps, params as SnapshotParams)],
    // sessions.purge: `memory forget --purge-sessions` reaching the redacted
    // transcripts, still through the single writer.
    ['sessions.purge', (params) => runPurgeSessions(deps, params as PurgeSessionsParams)],
  ]);
}
