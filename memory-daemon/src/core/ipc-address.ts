import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { runtimeDir } from './paths.js';

/**
 * The SINGLE formula for the daemon's IPC address, imported by daemon, proxy,
 * CLI and hooks. A divergent formula between hook and proxy breaks the product
 * silently (review point B6). The address is also the daemon's single-instance
 * mutex: only one process can listen on it.
 *
 * Windows: a named pipe (`\\.\pipe\memory-vault.v1.<user>`). The pipe is a
 * kernel object: it dies with the owning process and never leaves an orphan, so
 * an exclusive listen alone is a correct mutex.
 *
 * macOS / Linux: a Unix domain socket FILE under the per-user runtime dir
 * (`<runtimeDir>/memory-vault.v1.<user>.sock`). Same identity, but the file is
 * NOT removed by the kernel on a crash or SIGKILL, so the daemon adds
 * probe-then-unlink-then-relisten recovery on top of the listen (see
 * daemon/server.ts). That is the only safe way to reuse a stale socket.
 */

const BASE = 'memory-vault.v1';

/**
 * True when the IPC address is a filesystem Unix socket (macOS/Linux), false
 * for a Windows named pipe. The stale-file recovery in the daemon only applies
 * to sockets; on Windows the pipe can never be stale.
 */
export function isUnixSocket(): boolean {
  return process.platform !== 'win32';
}

export function pipeName(): string {
  const override = process.env['MEMORY_PIPE_NAME'];
  if (override) return override;
  const user = os.userInfo().username;
  if (process.platform === 'win32') return `\\\\.\\pipe\\${BASE}.${user}`;
  return unixSocketPath(user);
}

/**
 * Builds the Unix socket path under the runtime dir, namespaced by username so
 * two OS users never collide.
 *
 * POSIX caps a socket path (sockaddr_un.sun_path) at ~104 bytes and silently
 * truncates a longer one, which would make the daemon unreachable. runtimeDir()
 * is chosen to be short, but a long home plus a long username can still overflow
 * on macOS; when it would, the username is replaced by a short, stable hash so
 * the path always fits. The hash is deterministic, so daemon, proxy, CLI and
 * hooks still all agree on the same address.
 */
function unixSocketPath(user: string): string {
  const dir = runtimeDir();
  const full = path.join(dir, `${BASE}.${user}.sock`);
  // Leave margin under the ~104-byte OS limit for the runtime dir itself.
  const SUN_PATH_BUDGET = 100;
  if (Buffer.byteLength(full) <= SUN_PATH_BUDGET) return full;
  const short = crypto.createHash('sha256').update(user).digest('hex').slice(0, 12);
  return path.join(dir, `${BASE}.${short}.sock`);
}
