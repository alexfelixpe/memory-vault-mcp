import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatch, captureEgressLine } from '../../src/cli/memory.js';

/**
 * The privacy panel's read-out: `memory doctor` must state, in plain words, what
 * leaves the machine (capture/egress) and must NOT download the embedding model
 * when embeddings are disabled. Hermetic: every path is redirected to a temp dir
 * via the MEMORY_*_DIR / MEMORY_CONFIG env overrides, and OPENROUTER_* is cleared
 * so the developer's real key and config never leak in.
 */

const ENV_KEYS = [
  'MEMORY_CONFIG', 'MEMORY_CONFIG_DIR', 'MEMORY_DATA_DIR', 'MEMORY_CACHE_DIR',
  'MEMORY_INDEX_DIR', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL',
] as const;

let tmp: string;
let saved: Record<string, string | undefined>;
const FAKE_KEY = 'sk-or-FAKEKEY-do-not-print-abc123';

/** Redirects every on-disk footprint into tmp and writes a config with the given egress/embeddings state. */
function hermeticConfig(opts: { capture: boolean; embeddings: boolean }): void {
  const vault = path.join(tmp, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const cfg = path.join(tmp, 'config.yml');
  let body = `vaults:\n  global: ${JSON.stringify(vault)}\ndefault_vault: global\n`
    + `embeddings:\n  enabled: ${opts.embeddings}\n`;
  if (opts.capture) body += `openrouter:\n  api_key: ${JSON.stringify(FAKE_KEY)}\n`;
  fs.writeFileSync(cfg, body, 'utf8');

  process.env['MEMORY_CONFIG'] = cfg;
  process.env['MEMORY_CONFIG_DIR'] = path.join(tmp, 'cfgdir'); // empty: no OS-dir key
  process.env['MEMORY_DATA_DIR'] = path.join(tmp, 'data');
  process.env['MEMORY_CACHE_DIR'] = path.join(tmp, 'cache');
  process.env['MEMORY_INDEX_DIR'] = path.join(tmp, 'index');
  delete process.env['OPENROUTER_API_KEY'];
  delete process.env['OPENROUTER_MODEL'];
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-privacy-'));
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

/** Runs `memory doctor`, returning every console.log line joined. */
async function runDoctorCapturing(): Promise<string> {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    await dispatch(['doctor']);
  } finally {
    log.mockRestore();
  }
  return lines.join('\n');
}

describe('memory doctor — egress visibility', () => {
  it('prints the OFF egress line when no OpenRouter key is configured', async () => {
    hermeticConfig({ capture: false, embeddings: false });
    const out = await runDoctorCapturing();
    expect(out).toContain('Capture: OFF -- no session text leaves this machine.');
  });

  it('prints the ON/OpenRouter egress line when a key is present, without the key value', async () => {
    hermeticConfig({ capture: true, embeddings: false });
    const out = await runDoctorCapturing();
    expect(out).toContain('Capture: ON');
    expect(out).toContain('OpenRouter');
    // The key value is never printed.
    expect(out).not.toContain(FAKE_KEY);
  });

  it('reports embeddings disabled and does NOT create the model cache when disabled', async () => {
    hermeticConfig({ capture: false, embeddings: false });
    const out = await runDoctorCapturing();
    expect(out).toContain('disabled in config');
    // The embed self-test never ran, so nothing populated the model cache dir.
    expect(fs.existsSync(path.join(tmp, 'cache'))).toBe(false);
  });
});

describe('captureEgressLine', () => {
  it('is the exact OFF/ON copy and never carries a key', () => {
    expect(captureEgressLine(false)).toBe('Capture: OFF -- no session text leaves this machine.');
    expect(captureEgressLine(true)).toBe(
      'Capture: ON -- session snippets are sent to OpenRouter (openrouter.ai, a third-party LLM API in the US) for triage.',
    );
  });
});
