import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildHooksBlock, hookCommand, registerClaudeHooks, resolveHookScripts,
  unregisterClaudeHooks, SettingsParseError, type HookScripts,
} from '../../src/cli/hooks-register.js';

/**
 * Claude Code hook registration. Every case points at a TEMP settings.json, so
 * the developer's real ~/.claude/settings.json is never touched.
 */

let tmp: string;
let settingsPath: string;
const scripts: HookScripts = resolveHookScripts();

/** A settings.json with one unrelated Stop hook and an unrelated top-level key. */
const EXISTING = {
  permissions: { allow: ['Bash(git status)'] },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'node /home/me/my-formatter.js' }] }],
  },
};

function readSettings(): Record<string, any> {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-hooks-'));
  settingsPath = path.join(tmp, 'settings.json');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

describe('registerClaudeHooks (merge)', () => {
  it('merges the three hooks into an existing file, preserves unrelated hooks, and writes a .bak', () => {
    fs.writeFileSync(settingsPath, JSON.stringify(EXISTING, null, 2), 'utf8');

    const res = registerClaudeHooks({ settingsPath, scripts, createIfMissing: false });

    expect(res.action).toBe('merged');
    expect(res.backupPath).toBe(settingsPath + '.bak');
    // The backup holds the ORIGINAL bytes, before we changed anything.
    expect(JSON.parse(fs.readFileSync(res.backupPath!, 'utf8'))).toEqual(EXISTING);

    const s = readSettings();
    // All three events are wired to our built scripts.
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe(hookCommand(scripts.sessionStart));
    expect(s.hooks.SessionEnd[0].hooks[0].command).toBe(hookCommand(scripts.sessionEnd));
    // The unrelated Stop hook is kept; ours is ADDED alongside it (2 groups).
    const stopCommands = s.hooks.Stop.map((g: any) => g.hooks[0].command);
    expect(stopCommands).toContain('node /home/me/my-formatter.js');
    expect(stopCommands.some((c: string) => c.includes('turn-counter.js'))).toBe(true);
    expect(s.hooks.Stop).toHaveLength(2);
    // Unrelated top-level config is untouched.
    expect(s.permissions).toEqual(EXISTING.permissions);
  });

  it('is idempotent: a second run adds no duplicate group', () => {
    fs.writeFileSync(settingsPath, JSON.stringify(EXISTING, null, 2), 'utf8');
    registerClaudeHooks({ settingsPath, scripts, createIfMissing: false });
    const second = registerClaudeHooks({ settingsPath, scripts, createIfMissing: false });

    // Nothing new to add the second time; paths already point at this install.
    expect(second.addedEvents).toEqual([]);
    expect(second.updatedEvents).toEqual([]);
    const s = readSettings();
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionEnd).toHaveLength(1);
    expect(s.hooks.Stop).toHaveLength(2); // the foreign one plus ours, still just two
  });

  it('refreshes our command when the install path changed (moved clone)', () => {
    const stale = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node /old/clone/dist/hooks/session-start.js' }] }],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(stale, null, 2), 'utf8');

    const res = registerClaudeHooks({ settingsPath, scripts, createIfMissing: false });

    expect(res.updatedEvents).toContain('SessionStart');
    const s = readSettings();
    // The single SessionStart group now points at THIS install, not the old one.
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe(hookCommand(scripts.sessionStart));
  });

  it('writes the per-event extras, so --hooks matches the manual block', () => {
    registerClaudeHooks({ settingsPath, scripts, createIfMissing: true });
    const s = readSettings();

    const stop = s.hooks.Stop.find((g: any) => g.hooks[0].command.includes('turn-counter.js')).hooks[0];
    expect(stop.asyncRewake).toBe(true);
    expect(stop.rewakeSummary).toBe('Memory capture warning');
    expect(stop.timeout).toBe(10);
    expect(s.hooks.SessionStart[0].hooks[0].timeout).toBe(15);
    expect(s.hooks.SessionStart[0].hooks[0].statusMessage).toBe('Loading personal memory...');
    expect(s.hooks.SessionEnd[0].hooks[0].async).toBe(true);
  });

  it('repairs an entry registered before the extras were written', () => {
    // The path is already current, so only the missing extras can mark it updated.
    const noExtras = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: hookCommand(scripts.stop) }] }] },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(noExtras, null, 2), 'utf8');

    const res = registerClaudeHooks({ settingsPath, scripts, createIfMissing: false });

    expect(res.updatedEvents).toContain('Stop');
    const stop = readSettings().hooks.Stop[0].hooks[0];
    expect(stop.asyncRewake).toBe(true);
    expect(stop.timeout).toBe(10);
  });

  it('fills only the absent extras, keeping a value the owner set by hand', () => {
    const handTuned = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: hookCommand(scripts.stop), timeout: 99 }] }] },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(handTuned, null, 2), 'utf8');

    registerClaudeHooks({ settingsPath, scripts, createIfMissing: false });

    const stop = readSettings().hooks.Stop[0].hooks[0];
    expect(stop.timeout).toBe(99);
    expect(stop.asyncRewake).toBe(true);
  });
});

describe('registerClaudeHooks (create / refuse)', () => {
  it('does not create a missing file when createIfMissing is false', () => {
    const res = registerClaudeHooks({ settingsPath, scripts, createIfMissing: false });
    expect(res.action).toBe('missing');
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it('creates a fresh settings.json (no .bak) when asked to', () => {
    const res = registerClaudeHooks({ settingsPath, scripts, createIfMissing: true });
    expect(res.action).toBe('created');
    expect(res.backupPath).toBeUndefined();
    const s = readSettings();
    expect(Object.keys(s.hooks).sort()).toEqual(['SessionEnd', 'SessionStart', 'Stop']);
  });

  it('refuses to overwrite malformed JSON and leaves the file untouched', () => {
    const junk = '{ this is not json';
    fs.writeFileSync(settingsPath, junk, 'utf8');
    expect(() => registerClaudeHooks({ settingsPath, scripts, createIfMissing: false }))
      .toThrow(SettingsParseError);
    // The bad file is left exactly as it was, and no .bak was written.
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(junk);
    expect(fs.existsSync(settingsPath + '.bak')).toBe(false);
  });
});

describe('unregisterClaudeHooks (uninstall)', () => {
  it('removes only our three hooks, preserves unrelated ones, and writes a .bak', () => {
    // Start from a file that has our hooks registered alongside a foreign one.
    fs.writeFileSync(settingsPath, JSON.stringify(EXISTING, null, 2), 'utf8');
    registerClaudeHooks({ settingsPath, scripts, createIfMissing: false });
    fs.rmSync(settingsPath + '.bak'); // clear the register .bak so we assert on unregister's own

    const res = unregisterClaudeHooks(settingsPath);

    expect(res.action).toBe('updated');
    expect(res.backupPath).toBe(settingsPath + '.bak');
    expect(fs.existsSync(res.backupPath!)).toBe(true);
    expect(res.removedEvents.sort()).toEqual(['SessionEnd', 'SessionStart', 'Stop']);

    const s = readSettings();
    // Our SessionStart / SessionEnd groups were the only ones there -> events gone.
    expect(s.hooks.SessionStart).toBeUndefined();
    expect(s.hooks.SessionEnd).toBeUndefined();
    // The foreign Stop hook survives; ours is removed (back to one group).
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.Stop[0].hooks[0].command).toBe('node /home/me/my-formatter.js');
    // Unrelated top-level config is untouched.
    expect(s.permissions).toEqual(EXISTING.permissions);
  });

  it('reports not_found and writes no .bak when none of our hooks are present', () => {
    const foreignOnly = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /home/me/other.js' }] }] } };
    fs.writeFileSync(settingsPath, JSON.stringify(foreignOnly, null, 2), 'utf8');

    const res = unregisterClaudeHooks(settingsPath);

    expect(res.action).toBe('not_found');
    expect(fs.existsSync(settingsPath + '.bak')).toBe(false);
    expect(readSettings()).toEqual(foreignOnly);
  });

  it('reports missing when there is no settings file', () => {
    const res = unregisterClaudeHooks(settingsPath);
    expect(res.action).toBe('missing');
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it('refuses to touch malformed JSON', () => {
    fs.writeFileSync(settingsPath, '{ not json', 'utf8');
    expect(() => unregisterClaudeHooks(settingsPath)).toThrow(SettingsParseError);
    expect(fs.existsSync(settingsPath + '.bak')).toBe(false);
  });
});

describe('buildHooksBlock / resolveHookScripts', () => {
  it('builds a paste-ready block naming node + the three built scripts', () => {
    const block = buildHooksBlock(scripts);
    expect(Object.keys(block.hooks).sort()).toEqual(['SessionEnd', 'SessionStart', 'Stop']);
    const json = JSON.stringify(block);
    expect(json).toContain('session-start.js');
    expect(json).toContain('turn-counter.js');
    expect(json).toContain('session-end.js');
    expect(json).toContain('"type":"command"');
  });

  it('the Stop hook carries asyncRewake, so the capture auth notice can reach the person', () => {
    const block = buildHooksBlock(scripts);
    const stop = (block.hooks['Stop'] as Array<{ hooks: Array<Record<string, unknown>> }>)[0]!.hooks[0]!;
    expect(stop['command']).toContain('turn-counter.js');
    expect(stop['asyncRewake']).toBe(true);
    expect(stop['rewakeSummary']).toBe('Memory capture warning');
    // The session hooks stay non-rewake: they have nothing to tell the model.
    const start = (block.hooks['SessionStart'] as Array<{ hooks: Array<Record<string, unknown>> }>)[0]!.hooks[0]!;
    expect(start['asyncRewake']).toBeUndefined();
  });

  it('always resolves the built dist/hooks paths, even from the src layout', () => {
    for (const p of [scripts.sessionStart, scripts.stop, scripts.sessionEnd]) {
      expect(path.isAbsolute(p)).toBe(true);
      expect(p.includes(path.join('dist', 'hooks'))).toBe(true);
    }
  });
});
