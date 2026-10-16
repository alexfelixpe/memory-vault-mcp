import type { SearchRequest, SearchResponse } from '../index/search/search.js';
import type { ReconcileResult } from '../index/reconcile.js';
import type { GetParams, MutateParams, DailyParams, SnapshotParams, PurgeSessionsParams, PurgeSessionsData } from './write-pipeline.js';

/**
 * NDJSON protocol over the named pipe: one JSON line per message, in both
 * directions. Versioned from day 1: an old proxy talking to a new daemon gets
 * a typed error, never silently different behavior.
 */

export const PROTOCOL_VERSION = 1;

export interface Request {
  v: number;
  id: string;
  method: Method;
  params?: unknown;
  /**
   * Per-user shared secret (see core/auth-token.ts). Every real method is gated
   * on it: the server rejects a request whose token does not match with
   * AUTH_FAILED before it looks at the method. Optional on the wire only because
   * client and daemon ship together; the server now requires it.
   */
  token?: string;
}

export type Method = 'ping' | 'search' | 'status' | 'reindex' | 'shutdown'
  | 'get' | 'mutate' | 'daily' | 'snapshot' | 'sessions.purge'
  | 'capture.turn' | 'capture.flush' | 'backup';

export type Response<T = unknown> =
  | { v: number; id: string; ok: true; data: T }
  | { v: number; id: string; ok: false; error: { code: string; message: string; hint: string; [k: string]: unknown } };

export interface PingData {
  pid: number;
  version: string;
  uptimeMs: number;
  protocol: number;
}

export interface StatusData {
  pid: number;
  uptimeMs: number;
  lastReconcileAt: number | null;
  reconciling: boolean;
  watcherReady: boolean;
  watcherQueueSize: number;
  embedderWarm: boolean;
  embedBacklog: number;
  vectorSize: number;
  files: Array<{ vault: string; count: number }>;
  chunks: number;
  /**
   * True when an OpenRouter key is configured (capture ON: session snippets
   * egress for triage). The daemon is authoritative on its own config; the key
   * value is never sent. False = nothing leaves the machine.
   */
  captureOn: boolean;
  /** Standing capture problem a human must fix (CLI logged out); absent = healthy. */
  captureNotice?: string | undefined;
}

export interface ReindexParams {
  vault?: string | undefined;
}

export type ReindexData = Record<string, ReconcileResult>;

/** Method -> types map, so the client can type request() without a cast. */
export interface MethodMap {
  ping: { params: undefined; data: PingData };
  search: { params: SearchRequest; data: SearchResponse };
  status: { params: undefined; data: StatusData };
  reindex: { params: ReindexParams; data: ReindexData };
  shutdown: { params: undefined; data: { stopping: true } };
  get: { params: GetParams; data: Record<string, unknown> };
  mutate: { params: MutateParams; data: Record<string, unknown> };
  daily: { params: DailyParams; data: Record<string, unknown> };
  snapshot: { params: SnapshotParams; data: { body: string; sha256: string; frozen: boolean } };
  'sessions.purge': { params: PurgeSessionsParams; data: PurgeSessionsData };
  /**
   * `cwd` is the session's repo, sent by the Stop hook. The daemon resolves the
   * session's vault from it, so the triage context and the transcript copy follow
   * the repo instead of the daemon's own default vault. It is optional on the
   * wire (an older hook omits it), but a pass without it has no vault it may use
   * and is skipped: there is no shared vault to fall back to any more.
   */
  'capture.turn': { params: { session_id: string; transcript_path: string; cwd?: string | undefined }; data: { turns: number; scheduled: boolean; notice?: string | undefined } };
  'capture.flush': { params: { session_id: string; transcript_path: string; cwd?: string | undefined }; data: { flushing: boolean } };
  backup: { params: undefined; data: Record<string, unknown> };
}

export function errorResponse(id: string, code: string, message: string, hint: string): Response<never> {
  return { v: PROTOCOL_VERSION, id, ok: false, error: { code, message, hint } };
}

export function okResponse<T>(id: string, data: T): Response<T> {
  return { v: PROTOCOL_VERSION, id, ok: true, data };
}
