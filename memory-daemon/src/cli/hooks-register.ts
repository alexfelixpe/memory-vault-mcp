import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Registers the three Claude Code hooks (SessionStart, Stop, SessionEnd) into a
 * settings.json so personal memory turns on automatically. This is what makes
 * the "my agent just remembers me" promise real for Claude Code: without it,
 * `memory init` only prints an MCP line and nothing ever calls the hooks.
 *
 * Everything here is safe by construction: it MERGES into an existing `hooks`
 * block (never clobbering other hooks), writes a `.bak` first, and is idempotent
 * (re-running refreshes our own paths instead of adding duplicates). The target
 * file is always an explicit argument, so tests point it at a temp file and the
 * developer's real settings are never touched.
 */

/**
 * The Claude Code hook events we wire, in the order they are written, plus the
 * per-event extras the entry needs. Stop runs with asyncRewake: the hook stays
 * non-blocking, but an exit code 2 (the capture auth notice) wakes the model,
 * which tells the person inside the session. Without it the notice is dead on
 * a fresh install.
 */
const EVENT_SCRIPTS: ReadonlyArray<readonly [event: string, key: keyof HookScripts, extras: Record<string, unknown>]> = [
  ['SessionStart', 'sessionStart', { timeout: 15, statusMessage: 'Loading personal memory...' }],
  ['Stop', 'stop', { timeout: 10, asyncRewake: true, rewakeSummary: 'Memory capture warning' }],
  ['SessionEnd', 'sessionEnd', { timeout: 10, async: true }],
];

export interface HookScripts {
  /** Absolute path to dist/hooks/session-start.js */
  sessionStart: string;
  /** Absolute path to dist/hooks/turn-counter.js */
  stop: string;
  /** Absolute path to dist/hooks/session-end.js */
  sessionEnd: string;
}

/** A settings.json that exists but is not valid JSON: refuse to touch it. */
export class SettingsParseError extends Error {
  constructor(public readonly settingsPath: string) {
    super(
      `The settings file at ${settingsPath} is not valid JSON. `
      + 'Refusing to modify it so nothing is lost. Fix the JSON by hand, or paste the '
      + 'printed hooks block into it yourself.',
    );
    this.name = 'SettingsParseError';
  }
}

/**
 * Absolute paths to this install's three built hook scripts, resolved relative
 * to THIS module so they are correct wherever the repo was cloned. When the CLI
 * runs from the src layout (dev, tests), the resolved path points at src/hooks;
 * the registered command must always name the built entry, so the build-layout
 * segment ('src') is normalized to 'dist' — exactly like resolveMcpServerJs.
 */
export function resolveHookScripts(): HookScripts {
  const one = (rel: string): string => {
    const p = fileURLToPath(new URL(`../hooks/${rel}`, import.meta.url));
    const layoutDir = path.dirname(path.dirname(p)); // .../<layout>
    if (path.basename(layoutDir) === 'src') {
      return path.join(path.dirname(layoutDir), 'dist', 'hooks', rel);
    }
    return p;
  };
  return {
    sessionStart: one('session-start.js'),
    stop: one('turn-counter.js'),
    sessionEnd: one('session-end.js'),
  };
}

/**
 * The command string Claude Code runs for a hook. Claude Code executes this in a
 * shell, so the absolute path is quoted to survive a space in the path (a
 * username with a space, "Program Files", etc.).
 */
export function hookCommand(scriptPath: string): string {
  return `node "${scriptPath}"`;
}

/** The `{ hooks: { ... } }` block to paste into a settings.json by hand. */
export function buildHooksBlock(scripts: HookScripts): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {};
  for (const [event, key, extras] of EVENT_SCRIPTS) {
    hooks[event] = [{ hooks: [{ type: 'command', command: hookCommand(scripts[key]), ...extras }] }];
  }
  return { hooks };
}

export interface ClaudeDetection {
  /** true when any signal of Claude Code is present (a settings file or a .claude dir). */
  detected: boolean;
  /** <cwd>/.claude/settings.json */
  projectSettings: string;
  /** <home>/.claude/settings.json — where personal hooks belong (loads in every project). */
  userSettings: string;
  projectExists: boolean;
  userExists: boolean;
}

/**
 * Looks for Claude Code's settings files so init can decide whether to offer
 * hook registration. Personal memory should load in every session, so the user
 * settings file is the natural home; the project file is reported too.
 */
export function detectClaudeCode(cwd: string): ClaudeDetection {
  const projectSettings = path.join(cwd, '.claude', 'settings.json');
  const userSettings = path.join(os.homedir(), '.claude', 'settings.json');
  const projectExists = fs.existsSync(projectSettings);
  const userExists = fs.existsSync(userSettings);
  const dirExists = fs.existsSync(path.join(cwd, '.claude'))
    || fs.existsSync(path.join(os.homedir(), '.claude'));
  return { detected: projectExists || userExists || dirExists, projectSettings, userSettings, projectExists, userExists };
}

export interface RegisterOptions {
  /** Absolute path to the settings.json to modify. Always explicit (hermetic tests). */
  settingsPath: string;
  scripts: HookScripts;
  /** When the file does not exist: create it (true) or report 'missing' (false). */
  createIfMissing: boolean;
}

export interface RegisterResult {
  /** 'merged' into an existing file, 'created' a new one, or 'missing' (not created). */
  action: 'merged' | 'created' | 'missing';
  settingsPath: string;
  /** The .bak written before a merge (absent when the file was created). */
  backupPath?: string;
  /** Events where a new hook group was appended. */
  addedEvents: string[];
  /** Events where an existing memory hook's path was refreshed to this install. */
  updatedEvents: string[];
}

/**
 * Merges our three hooks into a parsed settings object, in place. For each event
 * it looks for a group that already references our script (by unique basename,
 * e.g. `session-start.js`); if found it refreshes the path (handles a moved
 * clone), otherwise it appends a new group. Every other event and every other
 * group in the same event are left exactly as they were.
 */
function mergeHooksInto(settings: Record<string, unknown>, scripts: HookScripts): { added: string[]; updated: string[] } {
  // Reuse an existing hooks object; only replace it if it is missing or malformed.
  const existing = settings['hooks'];
  const hooksObj: Record<string, unknown> = (existing && typeof existing === 'object' && !Array.isArray(existing))
    ? (existing as Record<string, unknown>)
    : {};
  settings['hooks'] = hooksObj;

  const added: string[] = [];
  const updated: string[] = [];
  for (const [event, key, extras] of EVENT_SCRIPTS) {
    const scriptPath = scripts[key];
    const basename = path.basename(scriptPath);
    const desired = hookCommand(scriptPath);

    // Normalize the event to an array of groups without dropping foreign hooks.
    let groups = hooksObj[event];
    if (!Array.isArray(groups)) { groups = []; hooksObj[event] = groups; }

    // Is our hook already there? Identify it by our unique script basename.
    let found = false;
    for (const group of groups as unknown[]) {
      if (!group || typeof group !== 'object') continue;
      const inner = (group as Record<string, unknown>)['hooks'];
      if (!Array.isArray(inner)) continue;
      for (const h of inner as unknown[]) {
        if (h && typeof h === 'object') {
          const entry = h as Record<string, unknown>;
          const cmd = entry['command'];
          if (typeof cmd === 'string' && cmd.includes(basename)) {
            found = true;
            let changed = false;
            if (cmd !== desired) { entry['command'] = desired; changed = true; }
            // An entry written before the extras were carried in still runs, but
            // without asyncRewake the capture notice never reaches the person.
            // Repair by filling only the ABSENT keys, so a timeout the owner
            // raised by hand is never stomped on a re-run.
            for (const [extraKey, extraValue] of Object.entries(extras)) {
              if (!(extraKey in entry)) { entry[extraKey] = extraValue; changed = true; }
            }
            if (changed) updated.push(event);
            break;
          }
        }
      }
      if (found) break;
    }
    if (!found) {
      // The per-event extras are the reason the hooks behave at all: the Stop
      // hook needs asyncRewake to surface the auth notice, SessionStart needs
      // its timeout and status message. Dropping them here is what made the
      // --hooks path differ from the manual block that buildHooksBlock prints.
      (groups as unknown[]).push({ hooks: [{ type: 'command', command: desired, ...extras }] });
      added.push(event);
    }
  }
  return { added, updated };
}

/**
 * Registers (merges) the three hooks into settingsPath. Writes a `.bak` before
 * modifying an existing file. Never clobbers unrelated hooks. Returns a
 * structured result so the CLI can report exactly what changed; the caller
 * prints the manual block when the result is 'missing'.
 */
export function registerClaudeHooks(opts: RegisterOptions): RegisterResult {
  const exists = fs.existsSync(opts.settingsPath);
  if (!exists && !opts.createIfMissing) {
    return { action: 'missing', settingsPath: opts.settingsPath, addedEvents: [], updatedEvents: [] };
  }

  let settings: Record<string, unknown> = {};
  let backupPath: string | undefined;
  if (exists) {
    const raw = fs.readFileSync(opts.settingsPath, 'utf8');
    // An empty file is fine; malformed JSON must never be silently overwritten.
    if (raw.trim() !== '') {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw new SettingsParseError(opts.settingsPath); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new SettingsParseError(opts.settingsPath);
      }
      settings = parsed as Record<string, unknown>;
    }
    // Back up the exact bytes we are about to change.
    backupPath = `${opts.settingsPath}.bak`;
    fs.copyFileSync(opts.settingsPath, backupPath);
  }

  const { added, updated } = mergeHooksInto(settings, opts.scripts);
  fs.mkdirSync(path.dirname(opts.settingsPath), { recursive: true });
  fs.writeFileSync(opts.settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');

  return {
    action: exists ? 'merged' : 'created',
    settingsPath: opts.settingsPath,
    ...(backupPath ? { backupPath } : {}),
    addedEvents: added,
    updatedEvents: updated,
  };
}

/**
 * The unique basenames of our three hook scripts. A hook is "ours" when its
 * command string contains one of these. Basenames are location-independent, so
 * this still recognizes our hooks after the clone was moved — the same identity
 * key mergeHooksInto uses to stay idempotent.
 */
export const OUR_HOOK_BASENAMES: readonly string[] = ['session-start.js', 'turn-counter.js', 'session-end.js'];

export interface UnregisterResult {
  /** 'updated' removed at least one of our hooks; 'not_found' had none; 'missing' had no file. */
  action: 'updated' | 'not_found' | 'missing';
  settingsPath: string;
  /** The .bak written before the change (absent when nothing changed). */
  backupPath?: string;
  /** Events from which one of our hooks was removed. */
  removedEvents: string[];
}

/** True when a hook command belongs to this system (matches one of our basenames). */
function isOurHookCommand(cmd: unknown): boolean {
  return typeof cmd === 'string' && OUR_HOOK_BASENAMES.some((b) => cmd.includes(b));
}

/**
 * Removes ONLY our three hook entries from a settings.json, preserving every
 * other hook and top-level key, and writes a `.bak` first. The inverse of
 * registerClaudeHooks, used by `memory uninstall`. A group that held only our
 * hook is dropped whole; an event left with no groups is removed; a foreign
 * (empty or not) group is never touched. Malformed JSON is refused, never
 * silently overwritten. Returns what changed so the CLI can report it.
 */
export function unregisterClaudeHooks(settingsPath: string): UnregisterResult {
  if (!fs.existsSync(settingsPath)) {
    return { action: 'missing', settingsPath, removedEvents: [] };
  }

  const raw = fs.readFileSync(settingsPath, 'utf8');
  let settings: Record<string, unknown> = {};
  if (raw.trim() !== '') {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new SettingsParseError(settingsPath); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SettingsParseError(settingsPath);
    settings = parsed as Record<string, unknown>;
  }

  const hooksVal = settings['hooks'];
  if (!hooksVal || typeof hooksVal !== 'object' || Array.isArray(hooksVal)) {
    return { action: 'not_found', settingsPath, removedEvents: [] };
  }
  const hooks = hooksVal as Record<string, unknown>;

  const removedEvents: string[] = [];
  // Scan every event (not only our three), so a hook a user moved to a
  // different event is still found and removed.
  for (const [event, groupsVal] of Object.entries(hooks)) {
    if (!Array.isArray(groupsVal)) continue;
    let eventChanged = false;
    const keptGroups: unknown[] = [];
    for (const group of groupsVal as unknown[]) {
      if (!group || typeof group !== 'object') { keptGroups.push(group); continue; }
      const inner = (group as Record<string, unknown>)['hooks'];
      if (!Array.isArray(inner)) { keptGroups.push(group); continue; }

      // Filter out our hook entries; a group changes only when one is dropped.
      let groupChanged = false;
      const keptInner = (inner as unknown[]).filter((h) => {
        const cmd = h && typeof h === 'object' ? (h as Record<string, unknown>)['command'] : undefined;
        if (isOurHookCommand(cmd)) { groupChanged = true; return false; }
        return true;
      });
      if (groupChanged) eventChanged = true;
      // Drop a group that was entirely ours; keep a foreign empty group as-is.
      if (groupChanged && keptInner.length === 0) continue;
      if (groupChanged) (group as Record<string, unknown>)['hooks'] = keptInner;
      keptGroups.push(group);
    }
    if (eventChanged) {
      removedEvents.push(event);
      if (keptGroups.length === 0) delete hooks[event];
      else hooks[event] = keptGroups;
    }
  }

  if (removedEvents.length === 0) {
    return { action: 'not_found', settingsPath, removedEvents: [] };
  }

  const backupPath = `${settingsPath}.bak`;
  fs.copyFileSync(settingsPath, backupPath);
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return { action: 'updated', settingsPath, backupPath, removedEvents };
}
