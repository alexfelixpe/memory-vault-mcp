import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Temporary vault for I/O tests. Every I/O test runs twice, with eol 'lf'
 * and 'crlf' (section 12 of the plan): that is where Windows breaks.
 */

export interface TmpVaultOptions {
  eol?: 'lf' | 'crlf';
  /** Prefixes each file with a UTF-8 BOM (Notepad does this). */
  bom?: boolean;
}

export interface TmpVault {
  root: string;
  writeFile(rel: string, content: string): void;
  cleanup(): void;
}

export const EOL_VARIANTS: Array<'lf' | 'crlf'> = ['lf', 'crlf'];

export function makeTmpVault(files: Record<string, string>, opts: TmpVaultOptions = {}): TmpVault {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-'));
  const writeFile = (rel: string, content: string): void => {
    let text = content;
    if (opts.eol === 'crlf') text = text.replace(/\n/g, '\r\n');
    if (opts.bom) text = '﻿' + text;
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
  };
  for (const [rel, content] of Object.entries(files)) writeFile(rel, content);
  return {
    root,
    writeFile,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
  };
}

/** Temporary directory for the index (gen-NNNNNN + CURRENT). */
export function makeTmpIndexDir(): { root: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memindex-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }) };
}
