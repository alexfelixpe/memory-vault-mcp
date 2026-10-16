import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { localAppDataDir } from './paths.js';

/**
 * Per-user shared secret that authenticates every IPC request to the daemon.
 *
 * The trust anchor is the per-user OS data directory (%LOCALAPPDATA%\memory on
 * Windows), NOT the repo or any vault: only the OS user can reach that path.
 * Both the daemon and every client derive the same token from the same file,
 * so there is no boot-order race with spawn-on-demand — whichever process runs
 * first creates the file, the rest read it.
 *
 * Why a token and not just transport permissions: pure Node cannot set the
 * Windows named-pipe security descriptor (DACL), so libuv's default ACL is all
 * the transport gives us there. The same-user token is therefore the real
 * access control on Windows. On POSIX the token file is additionally locked to
 * mode 0600 and the socket to 0600 (best-effort, done by the server).
 *
 * Documented residual risk: a process running as the SAME OS user can read this
 * file and impersonate a client. The token defends against a DIFFERENT local
 * identity and against any process that cannot read the file; it does not defend
 * against an attacker who is already the user or root (an explicit non-goal).
 */

const TOKEN_FILE = 'daemon.token';
const TOKEN_BYTES = 32;

// Per-process cache keyed by the resolved token path. The token never changes
// while a process runs, so re-reading the file on every request is wasteful.
// Keying by path keeps tests isolated when MEMORY_LOCALAPPDATA_DIR differs.
const cache = new Map<string, string>();

/** Absolute path of the token file for the current user (env-overridable via paths). */
export function tokenPath(): string {
  return path.join(localAppDataDir(), TOKEN_FILE);
}

/**
 * Returns the per-user token, creating it once if it does not exist yet.
 *
 * The create is atomic: the 'wx' flag fails with EEXIST if a concurrent starter
 * won the race, in which case we read the winner's value instead of clobbering
 * it. This is what makes daemon + spawn-on-demand client safe without ordering.
 */
export function getOrCreateToken(): string {
  const file = tokenPath();
  const cached = cache.get(file);
  if (cached) return cached;

  // Fast path: after first boot the file already exists for every caller.
  const existing = readToken(file);
  if (existing) {
    cache.set(file, existing);
    return existing;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  try {
    // 'wx': create-exclusive. Two starters racing here: exactly one wins the
    // write, the other gets EEXIST and falls through to read the winner.
    fs.writeFileSync(file, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    lockDownPermissions(file);
    cache.set(file, token);
    return token;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      const winner = readToken(file);
      if (winner) {
        cache.set(file, winner);
        return winner;
      }
    }
    throw e;
  }
}

/** Reads the token file, treating a missing or empty file as "no token yet". */
function readToken(file: string): string | undefined {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw.length > 0 ? raw : undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/**
 * POSIX: force the token file to 0600 (writeFileSync's mode is masked by umask,
 * so an explicit chmod is the only guarantee). No-op on Windows, where the pipe
 * DACL residual documented above applies instead.
 */
function lockDownPermissions(file: string): void {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort: an unusual filesystem may refuse chmod; the token still works */
  }
}
