import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import nodePath from 'node:path';
import type pino from 'pino';
import { PROTOCOL_VERSION, errorResponse, type Request, type Response } from './protocol.js';
import { getOrCreateToken } from '../core/auth-token.js';
import { isUnixSocket } from '../core/ipc-address.js';
import { ToolError } from './write-pipeline.js';

/**
 * NDJSON server over the IPC address. The exclusive listen is the
 * single-instance mutex.
 *
 * Windows (named pipe): EADDRINUSE/EACCES means "a healthy daemon already
 * exists"; the caller chooses to exit with code 0 (never an error). The pipe is
 * a kernel object, so it is never stale — no probing, no unlink.
 *
 * macOS / Linux (Unix domain socket): the socket is a FILE that libuv does NOT
 * remove on a crash or SIGKILL, so EADDRINUSE is ambiguous — it can mean a live
 * peer OR a stale leftover file. On EADDRINUSE we PROBE the socket: if a daemon
 * answers we step aside (PipeBusyError); if nothing answers the file is stale,
 * so we unlink it and listen again, bounded so it can never spin.
 */

/** How many EADDRINUSE rounds we handle before giving up (never spin). */
const MAX_STALE_ROUNDS = 2;
/** Short connect timeout for the liveness probe on a Unix socket. */
const PROBE_TIMEOUT_MS = 500;

export type Handler = (params: unknown) => Promise<unknown> | unknown;

export interface PipeServer {
  close(): Promise<void>;
}

export class PipeBusyError extends Error {
  readonly code = 'PIPE_BUSY';
  constructor(path: string) { super(`A daemon is already listening on ${path}`); }
}

const MAX_LINE_BYTES = 4 * 1024 * 1024; // a query never comes close to this

/**
 * Probes a Unix socket path to learn whether a real daemon is listening.
 * Resolves true if the connection is accepted (a live peer owns the socket) and
 * false if it is refused or the file is gone (ECONNREFUSED / ENOENT => a stale
 * leftover). A timeout resolves TRUE on purpose: when the answer is unclear we
 * assume a peer might exist rather than risk unlinking a live socket (the one
 * mistake that would make the daemon unreachable). A local socket with a real
 * listener is accepted by the kernel almost instantly, so the timeout only ever
 * fires in genuinely abnormal cases.
 */
function probeUnixSocketAlive(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ path: sockPath });
    let settled = false;
    const finish = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Best-effort removal of the Unix socket file. Used both to clear a stale
 * leftover before relistening and on graceful shutdown, so a normal exit never
 * leaves a file behind for the next start to probe. No-op on Windows (the pipe
 * is a kernel object, not a file). An already-gone file (ENOENT) is fine.
 */
function unlinkSocketIfUnix(sockPath: string, log: pino.Logger): void {
  if (!isUnixSocket()) return;
  try {
    fs.unlinkSync(sockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.debug(e, 'could not unlink unix socket');
  }
}

/**
 * Ensures the parent directory of the Unix socket exists before we bind. A
 * custom MEMORY_RUNTIME_DIR or an unusual XDG_RUNTIME_DIR can name a directory
 * that was never created; without this, server.listen({ path }) fails with
 * ENOENT/EACCES and the daemon dies with an unactionable "failed to start". A
 * fresh install has the same gap before `memory init` has run. recursive:true
 * so an already-present dir is fine. No-op on Windows: the named pipe has no
 * filesystem parent.
 */
function ensureSocketDirIfUnix(sockPath: string): void {
  if (!isUnixSocket()) return;
  fs.mkdirSync(nodePath.dirname(sockPath), { recursive: true });
}

export function startPipeServer(
  path: string,
  handlers: Map<string, Handler>,
  log: pino.Logger,
): Promise<PipeServer> {
  return new Promise((resolve, reject) => {
    // The expected token is read once at startup. Every request must carry it;
    // a same-user client reads the same file (core/auth-token.ts). This is the
    // in-process capability check the raw socket lacks: without it, any local
    // process that can open the pipe reaches the full read/write surface.
    const expectedToken = getOrCreateToken();
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));

      socket.on('data', (data: string) => {
        buffer += data;
        if (buffer.length > MAX_LINE_BYTES) {
          socket.destroy();
          return;
        }
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line !== '') void dispatch(line, socket);
        }
      });
      socket.on('error', (e) => log.debug(e, 'client socket dropped'));
    });

    async function dispatch(line: string, socket: net.Socket): Promise<void> {
      let req: Request;
      try {
        req = JSON.parse(line) as Request;
      } catch {
        write(socket, errorResponse('', 'BAD_JSON', 'Line is not valid JSON.', 'Send one NDJSON request per line.'));
        return;
      }
      if (req.v !== PROTOCOL_VERSION) {
        write(socket, errorResponse(req.id ?? '', 'PROTOCOL_MISMATCH',
          `Daemon speaks protocol v${PROTOCOL_VERSION}, client sent v${req.v}.`,
          'Update daemon and proxy together (npm run build) and try again.'));
        return;
      }
      // Authenticate before dispatching ANY method: a wrong or missing token
      // never reaches a handler, so no vault data is read or written. The socket
      // is dropped after the reply so a caller cannot brute-force on one
      // connection. Constant-time compare avoids leaking the token by timing.
      if (!tokenMatches(req.token, expectedToken)) {
        const res = errorResponse(req.id ?? '', 'AUTH_FAILED',
          'The request is missing a valid daemon token.',
          'The client and daemon must run as the same OS user; use the memory CLI or MCP proxy, not a raw socket.');
        if (!socket.destroyed) socket.write(JSON.stringify(res) + '\n', () => socket.destroy());
        else socket.destroy();
        return;
      }
      const handler = handlers.get(req.method);
      if (!handler) {
        write(socket, errorResponse(req.id, 'UNKNOWN_METHOD',
          `Method '${req.method}' does not exist.`,
          'Valid methods: ping, search, status, reindex, shutdown.'));
        return;
      }
      try {
        const data = await handler(req.params);
        write(socket, { v: PROTOCOL_VERSION, id: req.id, ok: true, data });
      } catch (e) {
        // A typed pipeline error crosses the pipe with its code, hint and data
        // (current_entries, candidates etc.); only the unexpected becomes INTERNAL.
        if (e instanceof ToolError) {
          write(socket, {
            v: PROTOCOL_VERSION, id: req.id, ok: false,
            error: { code: e.code, message: e.message, hint: e.hint, ...e.data },
          });
          return;
        }
        log.error(e, `handler ${req.method} failed`);
        write(socket, errorResponse(req.id, 'INTERNAL',
          e instanceof Error ? e.message : String(e),
          'Repeat the call; if it persists, run memory doctor.'));
      }
    }

    function write(socket: net.Socket, res: Response): void {
      if (!socket.destroyed) socket.write(JSON.stringify(res) + '\n');
    }

    /**
     * Constant-time token compare. A wrong type, empty string or length
     * mismatch is a fast reject; only equal-length buffers go to
     * timingSafeEqual (which throws on unequal lengths).
     */
    function tokenMatches(got: unknown, expected: string): boolean {
      if (typeof got !== 'string' || got.length === 0) return false;
      const a = Buffer.from(got);
      const b = Buffer.from(expected);
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    }

    // The startup outcome resolves exactly once: either we own the address
    // (onListening) or we step aside / fail (handleListenError -> reject).
    const onListening = (): void => {
      // POSIX defence-in-depth: lock the socket file to the owner (0600) so a
      // different local UID cannot even open it. Best-effort; skipped on
      // Windows (the path is a named pipe, not a filesystem node — the same-user
      // token is the control there, and pure Node cannot set the pipe DACL).
      if (isUnixSocket()) {
        try {
          fs.chmodSync(path, 0o600);
        } catch (e) {
          log.debug(e, 'could not chmod unix socket (best-effort)');
        }
      }
      log.info({ path }, 'pipe server listening');
      resolve({
        close: () => new Promise<void>((res) => {
          // server.close waits for open connections: drop them all first,
          // otherwise a hung client holds the shutdown forever.
          for (const s of sockets) s.destroy();
          server.close(() => {
            // Graceful exit: remove our own socket file so the next start never
            // has to probe a leftover. No-op on Windows.
            unlinkSocketIfUnix(path, log);
            res();
          });
        }),
      });
    };

    let staleRounds = 0;
    async function handleListenError(e: NodeJS.ErrnoException): Promise<void> {
      // WINDOWS — UNCHANGED. Binding a pipe already held by ANOTHER process
      // comes back as EACCES (libuv maps ERROR_ACCESS_DENIED); in the same
      // process it is EADDRINUSE. Both mean "a healthy daemon already exists".
      // A named pipe is a kernel object that dies with its owner, so it is never
      // stale: never probe, never unlink here.
      if (!isUnixSocket()) {
        if (e.code === 'EADDRINUSE' || e.code === 'EACCES') reject(new PipeBusyError(path));
        else reject(e);
        return;
      }
      // UNIX. Only EADDRINUSE is ambiguous (a live peer vs a stale leftover
      // file); every other listen error (EACCES on the directory, ENOENT, ...)
      // is a real failure and must surface. On Unix EACCES is NOT "peer alive".
      if (e.code !== 'EADDRINUSE') { reject(e); return; }
      staleRounds++;
      const alive = await probeUnixSocketAlive(path);
      if (alive) { reject(new PipeBusyError(path)); return; } // a healthy peer owns it
      if (staleRounds >= MAX_STALE_ROUNDS) {
        // Second EADDRINUSE with no answer: another daemon is racing us between
        // our unlink and its own listen. Do NOT unlink again — that could delete
        // a socket the winner is about to use. Give up with a clear error; the
        // caller (spawn-on-demand client) then reconnects to whichever won.
        reject(Object.assign(
          new Error(`Could not claim unix socket ${path}: address in use but no daemon answers, after ${staleRounds} attempts.`),
          { code: 'PIPE_UNCLAIMABLE' },
        ));
        return;
      }
      // Stale file, no listener: remove it (an already-gone file is fine) and
      // try to listen exactly once more. onError stays attached, so a second
      // EADDRINUSE re-enters this handler and hits the give-up branch above.
      try {
        fs.unlinkSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { reject(err as Error); return; }
      }
      log.warn({ path }, 'reclaimed a stale unix socket left by an unclean exit');
      ensureSocketDirIfUnix(path); // the parent may have gone with the crash
      server.listen({ path });
    }

    server.on('error', (e: NodeJS.ErrnoException) => { void handleListenError(e); });
    server.on('listening', onListening);
    ensureSocketDirIfUnix(path); // create the runtime dir before the first bind
    server.listen({ path });
  });
}
