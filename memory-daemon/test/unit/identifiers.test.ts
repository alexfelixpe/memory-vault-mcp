import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractIdentifiers, extractQueryIdentifiers, loadRegistryVocab,
} from '../../src/core/identifiers.js';

describe('extractIdentifiers', () => {
  it('extracts a ticket key, even inside a branch name', () => {
    expect(extractIdentifiers('we closed PROJ-123 on branch feat/PROJ-123')).toEqual(['PROJ-123']);
  });

  it('extracts a git SHA but not a plain number', () => {
    expect(extractIdentifiers('commit abc123f fixes everything')).toContain('ABC123F');
    expect(extractIdentifiers('there are 1234567 records')).toEqual([]);
  });

  it('extracts a vocabulary term with a word boundary', () => {
    const vocab = new Set(['BGE-M3']);
    expect(extractIdentifiers('we evaluated bge-m3 yesterday', vocab)).toContain('BGE-M3');
    expect(extractIdentifiers('we evaluated abge-m3x yesterday', vocab)).not.toContain('BGE-M3');
  });
});

describe('extractQueryIdentifiers', () => {
  it('accepts the loose form with a space: "PROJ 123" becomes PROJ-123 (T3)', () => {
    expect(extractQueryIdentifiers('what did we close in PROJ 123')).toContain('PROJ-123');
  });

  it('does not invent an identifier in a natural query', () => {
    expect(extractQueryIdentifiers('what did we decide about tenant isolation')).toEqual([]);
  });
});

describe('loadRegistryVocab', () => {
  it('collects wikilinks, code spans and bold from _registry.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memreg-'));
    fs.writeFileSync(path.join(dir, '_registry.md'), '- [[Aurora]]\n- `bge-m3`\n- **North Platform**\n');
    const vocab = loadRegistryVocab(dir);
    expect(vocab).toContain('AURORA');
    expect(vocab).toContain('BGE-M3');
    expect(vocab).toContain('NORTH PLATFORM');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a vault without a registry yields an empty vocabulary', () => {
    expect(loadRegistryVocab(os.tmpdir() + path.sep + 'does-not-exist').size).toBe(0);
  });

  it('finds the registry in Topics/ and reads the first column of its tables', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memreg-'));
    fs.mkdirSync(path.join(dir, 'Topics'));
    fs.writeFileSync(path.join(dir, 'Topics', '_registry.md'), [
      '| Canonical | Aliases (incl. transcription garbles) |',
      '|-----------|----------------------------------------|',
      '| Quillmark | Quilmark, quill mark |',
      '| Harbor Light | Harbor |',
      '',
    ].join('\n'));
    const vocab = loadRegistryVocab(dir);
    expect(vocab).toContain('QUILLMARK');
    expect(vocab).toContain('HARBOR LIGHT');
    // The header row and the aliases column are not controlled names.
    expect(vocab).not.toContain('CANONICAL');
    expect(vocab).not.toContain('QUILMARK, QUILL MARK');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('merges a root registry with the Topics one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memreg-'));
    fs.mkdirSync(path.join(dir, 'Topics'));
    fs.writeFileSync(path.join(dir, '_registry.md'), '- [[Aurora]]\n');
    fs.writeFileSync(path.join(dir, 'Topics', '_registry.md'), '| C |\n|---|\n| Quillmark |\n');
    const vocab = loadRegistryVocab(dir);
    expect(vocab).toContain('AURORA');
    expect(vocab).toContain('QUILLMARK');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
