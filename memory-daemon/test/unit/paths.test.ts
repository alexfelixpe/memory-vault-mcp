import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  configDir,
  dataDir,
  cacheDir,
  runtimeDir,
  appDataDir,
  localAppDataDir,
  indexRootDir,
} from '../../src/core/paths.js';

/**
 * Per-OS location resolver. Every case is hermetic: it mocks process.platform
 * and os.homedir() and clears every directory env var, so the result never
 * depends on the host running the suite (a Windows box or a Linux CI box).
 *
 * Expected paths are always built with path.join so separators match the host's
 * path module even when the platform value is mocked.
 */

const ENV_KEYS = [
  'MEMORY_CONFIG_DIR',
  'MEMORY_DATA_DIR',
  'MEMORY_CACHE_DIR',
  'MEMORY_RUNTIME_DIR',
  'MEMORY_APPDATA_DIR',
  'MEMORY_LOCALAPPDATA_DIR',
  'MEMORY_INDEX_DIR',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
];

const ORIG_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!;
let savedEnv: NodeJS.ProcessEnv;

/** Overrides process.platform for one test (restored in afterEach). */
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

/** Mocks the OS (platform + home) so resolution is fully host-independent. */
function mockOS(platform: NodeJS.Platform, home: string): void {
  setPlatform(platform);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
}

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', ORIG_PLATFORM);
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe('Windows locations (byte-for-byte unchanged)', () => {
  it('appDataDir/localAppDataDir/indexRootDir resolve to the same %APPDATA%/%LOCALAPPDATA% locations as before', () => {
    mockOS('win32', 'C:\\Users\\dev');
    process.env['APPDATA'] = 'C:\\Users\\dev\\AppData\\Roaming';
    process.env['LOCALAPPDATA'] = 'C:\\Users\\dev\\AppData\\Local';

    expect(appDataDir()).toBe(path.join(process.env['APPDATA'], 'memory'));
    expect(localAppDataDir()).toBe(path.join(process.env['LOCALAPPDATA'], 'memory'));
    expect(indexRootDir()).toBe(path.join(process.env['LOCALAPPDATA'], 'memory', 'index'));
    // New names are aliases of the old ones on Windows.
    expect(configDir()).toBe(appDataDir());
    expect(dataDir()).toBe(localAppDataDir());
    // The model cache keeps its historical location.
    expect(cacheDir()).toBe(path.join(process.env['LOCALAPPDATA'], 'memory', 'models'));
  });

  it('falls back to the homedir AppData path when APPDATA/LOCALAPPDATA are unset (unchanged)', () => {
    mockOS('win32', 'C:\\Users\\dev');
    expect(appDataDir()).toBe(path.join('C:\\Users\\dev', 'AppData', 'Roaming', 'memory'));
    expect(localAppDataDir()).toBe(path.join('C:\\Users\\dev', 'AppData', 'Local', 'memory'));
  });

  it('legacy MEMORY_APPDATA_DIR / MEMORY_LOCALAPPDATA_DIR overrides still win (existing tests rely on this)', () => {
    mockOS('win32', 'C:\\Users\\dev');
    process.env['MEMORY_APPDATA_DIR'] = 'C:\\tmp\\cfg';
    process.env['MEMORY_LOCALAPPDATA_DIR'] = 'C:\\tmp\\data';

    expect(appDataDir()).toBe('C:\\tmp\\cfg');
    expect(configDir()).toBe('C:\\tmp\\cfg');
    expect(localAppDataDir()).toBe('C:\\tmp\\data');
    expect(dataDir()).toBe('C:\\tmp\\data');
    expect(indexRootDir()).toBe(path.join('C:\\tmp\\data', 'index'));
  });
});

describe('macOS locations', () => {
  it('config, data and cache resolve under ~/Library on darwin', () => {
    mockOS('darwin', '/Users/testuser');
    const appSupport = path.join('/Users/testuser', 'Library', 'Application Support', 'memory');

    expect(configDir()).toBe(appSupport);
    expect(dataDir()).toBe(appSupport);
    expect(cacheDir()).toBe(path.join('/Users/testuser', 'Library', 'Caches', 'memory'));
    expect(indexRootDir()).toBe(path.join(appSupport, 'index'));
    // No per-user runtime dir on macOS: the socket lives in the data dir.
    expect(runtimeDir()).toBe(appSupport);
  });
});

describe('Linux locations', () => {
  it('uses ~/.config, ~/.local/share, ~/.cache when XDG_* are unset', () => {
    mockOS('linux', '/home/testuser');

    expect(configDir()).toBe(path.join('/home/testuser', '.config', 'memory'));
    expect(dataDir()).toBe(path.join('/home/testuser', '.local', 'share', 'memory'));
    expect(cacheDir()).toBe(path.join('/home/testuser', '.cache', 'memory'));
    // No XDG_RUNTIME_DIR: runtime falls back to the data dir.
    expect(runtimeDir()).toBe(path.join('/home/testuser', '.local', 'share', 'memory'));
  });

  it('honors absolute XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_CACHE_HOME/XDG_RUNTIME_DIR', () => {
    mockOS('linux', '/home/testuser');
    process.env['XDG_CONFIG_HOME'] = '/xdg/config';
    process.env['XDG_DATA_HOME'] = '/xdg/data';
    process.env['XDG_CACHE_HOME'] = '/xdg/cache';
    process.env['XDG_RUNTIME_DIR'] = '/run/user/1000';

    expect(configDir()).toBe(path.join('/xdg/config', 'memory'));
    expect(dataDir()).toBe(path.join('/xdg/data', 'memory'));
    expect(cacheDir()).toBe(path.join('/xdg/cache', 'memory'));
    expect(runtimeDir()).toBe('/run/user/1000');
    expect(indexRootDir()).toBe(path.join('/xdg/data', 'memory', 'index'));
  });

  it('ignores a relative XDG path and falls back to HOME (XDG spec: absolute only)', () => {
    mockOS('linux', '/home/testuser');
    process.env['XDG_CONFIG_HOME'] = 'relative/not/absolute';
    process.env['XDG_RUNTIME_DIR'] = 'also/relative';

    expect(configDir()).toBe(path.join('/home/testuser', '.config', 'memory'));
    expect(runtimeDir()).toBe(path.join('/home/testuser', '.local', 'share', 'memory'));
  });
});

describe('the index dir lives under the DATA dir on every OS, never the cache dir', () => {
  const CASES: Array<[NodeJS.Platform, string]> = [
    ['win32', 'C:\\Users\\dev'],
    ['darwin', '/Users/testuser'],
    ['linux', '/home/testuser'],
  ];

  it.each(CASES)('index is under data and not under cache on %s', (platform, home) => {
    mockOS(platform, home);
    if (platform === 'win32') {
      process.env['APPDATA'] = 'C:\\Users\\dev\\AppData\\Roaming';
      process.env['LOCALAPPDATA'] = 'C:\\Users\\dev\\AppData\\Local';
    }

    expect(path.dirname(indexRootDir())).toBe(dataDir());
    // A cache cleaner deleting a WAL mid-run corrupts the index, so the index
    // must never sit inside the cache dir.
    expect(indexRootDir().startsWith(cacheDir() + path.sep)).toBe(false);
  });
});

describe('env overrides for the new dirs (test/CI redirection)', () => {
  it('MEMORY_CONFIG_DIR / MEMORY_DATA_DIR / MEMORY_CACHE_DIR / MEMORY_RUNTIME_DIR each redirect their dir', () => {
    mockOS('linux', '/home/testuser');
    process.env['MEMORY_CONFIG_DIR'] = '/redir/config';
    process.env['MEMORY_DATA_DIR'] = '/redir/data';
    process.env['MEMORY_CACHE_DIR'] = '/redir/cache';
    process.env['MEMORY_RUNTIME_DIR'] = '/redir/run';

    expect(configDir()).toBe('/redir/config');
    expect(dataDir()).toBe('/redir/data');
    expect(cacheDir()).toBe('/redir/cache');
    expect(runtimeDir()).toBe('/redir/run');
    expect(indexRootDir()).toBe(path.join('/redir/data', 'index'));
  });

  it('MEMORY_DATA_DIR takes precedence over the legacy MEMORY_LOCALAPPDATA_DIR', () => {
    mockOS('linux', '/home/testuser');
    process.env['MEMORY_DATA_DIR'] = '/new/data';
    process.env['MEMORY_LOCALAPPDATA_DIR'] = '/legacy/data';

    expect(dataDir()).toBe('/new/data');
  });
});
