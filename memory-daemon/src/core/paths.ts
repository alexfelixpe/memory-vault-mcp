import os from 'node:os';
import path from 'node:path';

/**
 * Per-OS base directories for the daemon's state.
 *
 * Three distinct roles, each with its own correct folder per operating system:
 *   - config: user config (config.yml) and the client-term denylist;
 *   - data:   the SQLite index, the auth token, and logs. This must survive a
 *             cache cleaner: if a cleaner deletes a WAL file mid-run the index
 *             corrupts, so the index NEVER lives in a cache dir;
 *   - cache:  the downloaded embedding model (large, re-downloadable).
 *
 * Windows keeps its historical layout byte-for-byte: config in %APPDATA%\memory,
 * data in %LOCALAPPDATA%\memory, model cache in %LOCALAPPDATA%\memory\models.
 * The legacy exports appDataDir()/localAppDataDir() stay as thin aliases so
 * existing callers keep working, and the legacy env overrides keep working too.
 *
 * Every directory has a MEMORY_*_DIR env override in the same style, so tests
 * and CI can redirect it without touching the real user profile.
 */

const APP = 'memory';

/**
 * Resolves an XDG base directory (Linux). Per the XDG Base Directory spec the
 * variable is honored only when it is set to an absolute path; otherwise the
 * given HOME-relative fallback applies.
 */
function xdgBase(envVar: string, homeFallback: string[]): string {
  const val = process.env[envVar];
  if (val && path.isAbsolute(val)) return val;
  return path.join(os.homedir(), ...homeFallback);
}

/** Windows %APPDATA% (Roaming), with the historical homedir fallback. */
function winRoaming(): string {
  return process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
}

/** Windows %LOCALAPPDATA% (Local), with the historical homedir fallback. */
function winLocal(): string {
  return process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
}

/**
 * Config directory: holds config.yml and the client-term denylist.
 *   Windows: %APPDATA%\memory
 *   macOS:   ~/Library/Application Support/memory
 *   Linux:   $XDG_CONFIG_HOME/memory else ~/.config/memory
 * Env override: MEMORY_CONFIG_DIR, then the legacy MEMORY_APPDATA_DIR.
 */
export function configDir(): string {
  if (process.env['MEMORY_CONFIG_DIR']) return process.env['MEMORY_CONFIG_DIR'];
  if (process.env['MEMORY_APPDATA_DIR']) return process.env['MEMORY_APPDATA_DIR'];
  switch (process.platform) {
    case 'win32':
      return path.join(winRoaming(), APP);
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', APP);
    default:
      return path.join(xdgBase('XDG_CONFIG_HOME', ['.config']), APP);
  }
}

/**
 * Data directory: holds the SQLite index, the auth token, and logs. Never a
 * cache dir, because a cache cleaner deleting a WAL mid-run corrupts the index.
 *   Windows: %LOCALAPPDATA%\memory
 *   macOS:   ~/Library/Application Support/memory
 *   Linux:   $XDG_DATA_HOME/memory else ~/.local/share/memory
 * Env override: MEMORY_DATA_DIR, then the legacy MEMORY_LOCALAPPDATA_DIR.
 */
export function dataDir(): string {
  if (process.env['MEMORY_DATA_DIR']) return process.env['MEMORY_DATA_DIR'];
  if (process.env['MEMORY_LOCALAPPDATA_DIR']) return process.env['MEMORY_LOCALAPPDATA_DIR'];
  switch (process.platform) {
    case 'win32':
      return path.join(winLocal(), APP);
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', APP);
    default:
      return path.join(xdgBase('XDG_DATA_HOME', ['.local', 'share']), APP);
  }
}

/**
 * Cache directory: holds the downloaded embedding model (re-downloadable).
 *   Windows: %LOCALAPPDATA%\memory\models  (unchanged model location)
 *   macOS:   ~/Library/Caches/memory
 *   Linux:   $XDG_CACHE_HOME/memory else ~/.cache/memory
 * Env override: MEMORY_CACHE_DIR.
 */
export function cacheDir(): string {
  if (process.env['MEMORY_CACHE_DIR']) return process.env['MEMORY_CACHE_DIR'];
  switch (process.platform) {
    case 'win32':
      // Keep the model where it has always lived on Windows:
      // %LOCALAPPDATA%\memory\models (a subfolder of the data dir).
      return path.join(dataDir(), 'models');
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Caches', APP);
    default:
      return path.join(xdgBase('XDG_CACHE_HOME', ['.cache']), APP);
  }
}

/**
 * Runtime directory for the Unix domain socket (the IPC work that comes next).
 *   Linux:   $XDG_RUNTIME_DIR if set (and absolute), else the data dir
 *   macOS:   the data dir
 *   Windows: the data dir (unused there; IPC is a named pipe, not a socket file)
 * Env override: MEMORY_RUNTIME_DIR.
 */
export function runtimeDir(): string {
  if (process.env['MEMORY_RUNTIME_DIR']) return process.env['MEMORY_RUNTIME_DIR'];
  // Only Linux ships a per-user runtime dir; macOS and Windows have none.
  if (process.platform === 'linux') {
    const xdg = process.env['XDG_RUNTIME_DIR'];
    if (xdg && path.isAbsolute(xdg)) return xdg;
  }
  return dataDir();
}

/**
 * @deprecated Windows-era name, kept as an alias for {@link configDir}. On
 * Windows it still resolves to %APPDATA%\memory; elsewhere it returns the
 * correct per-OS config dir. Prefer configDir() in new code.
 */
export function appDataDir(): string {
  return configDir();
}

/**
 * @deprecated Windows-era name, kept as an alias for {@link dataDir}. On
 * Windows it still resolves to %LOCALAPPDATA%\memory; elsewhere it returns the
 * correct per-OS data dir. Prefer dataDir() in new code.
 */
export function localAppDataDir(): string {
  return dataDir();
}

/**
 * SQLite index root (contains gen-NNNNNN/ and the CURRENT file). Always under
 * the DATA dir on every OS, never a cache dir.
 */
export function indexRootDir(): string {
  return path.join(dataDir(), 'index');
}

/**
 * Converts an absolute vault file path to the canonical relative path
 * used in the index: '/' separator, no leading './'.
 * Throws if the file is outside the vault (defense against path traversal).
 */
export function toVaultRelPosix(vaultRoot: string, absFile: string): string {
  const rel = path.relative(path.resolve(vaultRoot), path.resolve(absFile));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`PATH_OUTSIDE_VAULT: ${absFile} is not inside ${vaultRoot}`);
  }
  return rel.split(path.sep).join('/');
}

/**
 * \\?\ prefix for long Windows paths (above ~240 chars). No-op on macOS and
 * Linux, which have no such prefix and no MAX_PATH limit.
 */
export function toLongPath(abs: string): string {
  if (process.platform !== 'win32') return abs;
  if (abs.startsWith('\\\\?\\')) return abs;
  if (abs.length < 240) return abs;
  return `\\\\?\\${abs}`;
}
