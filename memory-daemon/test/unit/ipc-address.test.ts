import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import { pipeName } from '../../src/core/ipc-address.js';

const saved = process.env['MEMORY_PIPE_NAME'];
afterEach(() => {
  if (saved === undefined) delete process.env['MEMORY_PIPE_NAME'];
  else process.env['MEMORY_PIPE_NAME'] = saved;
});

describe('pipeName', () => {
  it('single formula: memory-vault.v1.<username>', () => {
    delete process.env['MEMORY_PIPE_NAME'];
    const name = pipeName();
    expect(name).toContain('memory-vault.v1.');
    expect(name).toContain(os.userInfo().username);
    if (process.platform === 'win32') expect(name.startsWith('\\\\.\\pipe\\')).toBe(true);
  });

  it('is deterministic (proxy, daemon and hooks see the same name)', () => {
    delete process.env['MEMORY_PIPE_NAME'];
    expect(pipeName()).toBe(pipeName());
  });

  it('MEMORY_PIPE_NAME overrides (test isolation)', () => {
    process.env['MEMORY_PIPE_NAME'] = '\\\\.\\pipe\\custom.test';
    expect(pipeName()).toBe('\\\\.\\pipe\\custom.test');
  });
});
