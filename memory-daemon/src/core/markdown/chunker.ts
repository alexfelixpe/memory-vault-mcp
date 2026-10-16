/**
 * Chunker: splits a note's body into retrieval units of ~400 tokens with
 * an overlap of 80 (section 4 of the plan). Each chunk carries a context
 * prefix '<file> | <date> | <section/speaker>' that goes into BM25 and
 * (in Increment 3) into the embedding; it is the biggest recall gain for
 * transcripts, because it kills the orphan pronoun.
 */

export const CHUNK_TARGET_TOKENS = 400;
export const CHUNK_OVERLAP_TOKENS = 80;

export type ChunkKind = 'header' | 'bullet' | 'turn' | 'prose';

export interface Chunk {
  ordinal: number;
  kind: ChunkKind;
  headingPath: string | null;
  headingSlug: string | null;
  speaker: string | null;
  contextPrefix: string;
  body: string;
  anchorSubstring: string;
  /** Offsets in the file's FULL canonical content (with frontmatter). */
  charStart: number;
  charEnd: number;
  /** 1-based line in the full file. */
  startLine: number;
  tokenCount: number;
}

export interface ChunkInput {
  /** File name without extension; first part of the context prefix. */
  fileLabel: string;
  /** Document ISO date, or null when unknown. */
  docDate: string | null;
  /** Canonical body, without the frontmatter. */
  body: string;
  /** Offset of the body within the full canonical file. */
  baseOffset: number;
  /** Number of frontmatter lines before the body. */
  baseLine: number;
}

interface Block {
  kind: ChunkKind;
  text: string;
  charStart: number;
  charEnd: number;
  line: number;
  tokens: number;
  speaker: string | null;
  headingPath: string | null;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const BULLET_RE = /^[-*+]\s+/;
const FENCE_RE = /^(```|~~~)/;
// Transcript turn: 'First Last: speech'. Short name, capitalized,
// up to 4 words; avoids matching 'Note:' by requiring at least 2 name chars.
const SPEAKER_RE = /^\*{0,2}([A-ZÀ-Ý][\wÀ-ÿ.'-]+(?: [A-ZÀ-Ý(][\wÀ-ÿ().'-]*){0,3})\*{0,2}:\s+\S/u;

function countTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0).length;
  return Math.ceil(words * 1.3); // approximation: PT/EN ~1.3 tokens per word
}

/** GitHub-style slug of the path's last heading. */
export function slugifyHeading(heading: string): string {
  return heading
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Splits the body into atomic blocks (heading, bullet, turn, prose). */
function splitBlocks(body: string): Block[] {
  const lines = body.split('\n');
  const blocks: Block[] = [];
  // Stack of headings by level to build 'H1 > H2'.
  const headingStack: Array<{ level: number; name: string }> = [];
  const currentPath = (): string | null =>
    headingStack.length > 0 ? headingStack.map((h) => h.name).join(' > ') : null;

  let inFence = false;
  let offset = 0;
  let i = 0;

  const lineEnd = (idx: number): number => offset + lines[idx]!.length;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      offset += line.length + 1;
      i++;
      continue;
    }

    const h = !inFence && HEADING_RE.exec(line);
    if (h) {
      const level = h[1]!.length;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, name: h[2]! });
      blocks.push({
        kind: 'header', text: line, charStart: offset, charEnd: lineEnd(i),
        line: i + 1, tokens: countTokens(line), speaker: null, headingPath: currentPath(),
      });
      offset += line.length + 1;
      i++;
      continue;
    }

    if (!inFence && BULLET_RE.test(line)) {
      // Bullet with continuations and indented children as a single block.
      const start = offset;
      const startLine = i + 1;
      let text = line;
      let end = lineEnd(i);
      offset += line.length + 1;
      i++;
      while (i < lines.length && /^\s+\S/.test(lines[i]!)) {
        text += '\n' + lines[i]!;
        end = lineEnd(i);
        offset += lines[i]!.length + 1;
        i++;
      }
      blocks.push({
        kind: 'bullet', text, charStart: start, charEnd: end,
        line: startLine, tokens: countTokens(text), speaker: null, headingPath: currentPath(),
      });
      continue;
    }

    const sp = !inFence && SPEAKER_RE.exec(line);
    if (sp) {
      // Turn: the speaker line plus the following lines until a blank line,
      // a new speaker, a heading or a bullet.
      const start = offset;
      const startLine = i + 1;
      let text = line;
      let end = lineEnd(i);
      offset += line.length + 1;
      i++;
      while (
        i < lines.length && lines[i]!.trim() !== '' &&
        !HEADING_RE.test(lines[i]!) && !BULLET_RE.test(lines[i]!) && !SPEAKER_RE.test(lines[i]!)
      ) {
        text += '\n' + lines[i]!;
        end = lineEnd(i);
        offset += lines[i]!.length + 1;
        i++;
      }
      blocks.push({
        kind: 'turn', text, charStart: start, charEnd: end,
        line: startLine, tokens: countTokens(text), speaker: sp[1]!, headingPath: currentPath(),
      });
      continue;
    }

    // Prose: contiguous lines; a whole code fence stays in the same block.
    const start = offset;
    const startLine = i + 1;
    let text = '';
    let end = offset;
    while (i < lines.length) {
      const l = lines[i]!;
      if (!inFence && text !== '' && (l.trim() === '' || HEADING_RE.test(l) || BULLET_RE.test(l) || SPEAKER_RE.test(l))) break;
      if (FENCE_RE.test(l)) inFence = !inFence;
      text += (text === '' ? '' : '\n') + l;
      end = lineEnd(i);
      offset += l.length + 1;
      i++;
      if (!inFence && l.trim() === '') break;
    }
    blocks.push({
      kind: 'prose', text: text.replace(/\n+$/, ''), charStart: start, charEnd: end,
      line: startLine, tokens: countTokens(text), speaker: null, headingPath: currentPath(),
    });
  }
  return blocks;
}

/** A block larger than the target is sliced by lines into pieces of ~target tokens. */
function hardSplit(block: Block): Block[] {
  if (block.tokens <= CHUNK_TARGET_TOKENS) return [block];
  const lines = block.text.split('\n');
  const pieces: Block[] = [];
  let buf: string[] = [];
  let bufTokens = 0;
  let charStart = block.charStart;
  let lineStart = block.line;
  let consumedLines = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const text = buf.join('\n');
    pieces.push({ ...block, text, tokens: countTokens(text), charStart, charEnd: charStart + text.length, line: lineStart });
    charStart += text.length + 1;
    lineStart = block.line + consumedLines;
    buf = [];
    bufTokens = 0;
  };

  for (const l of lines) {
    buf.push(l);
    consumedLines++;
    bufTokens += countTokens(l);
    if (bufTokens >= CHUNK_TARGET_TOKENS) flush();
  }
  flush();
  return pieces;
}

/** Builds the chunk's context prefix. */
function contextPrefix(input: ChunkInput, headingPath: string | null, speaker: string | null): string {
  const parts = [input.fileLabel];
  if (input.docDate) parts.push(input.docDate);
  const where = speaker ?? headingPath;
  if (where) parts.push(where);
  return parts.join(' | ');
}

/**
 * Groups blocks into chunks of up to ~400 tokens with an overlap of ~80,
 * never crossing a heading boundary (the section is the vault's semantic unit).
 */
export function chunkNote(input: ChunkInput): Chunk[] {
  const blocks = splitBlocks(input.body).flatMap(hardSplit);
  const chunks: Chunk[] = [];
  let acc: Block[] = [];

  const flush = () => {
    if (acc.length === 0) return;
    const first = acc[0]!;
    const last = acc[acc.length - 1]!;
    const body = acc.map((b) => b.text).join('\n');
    if (body.trim() === '') { acc = []; return; }
    const turn = acc.find((b) => b.kind === 'turn');
    const nonHeader = acc.find((b) => b.kind !== 'header');
    const kind: ChunkKind = turn ? 'turn' : (nonHeader ? nonHeader.kind : 'header');
    const headingPath = last.headingPath;
    const anchorSource = (nonHeader ?? first).text.split('\n').find((l) => l.trim() !== '') ?? '';
    chunks.push({
      ordinal: chunks.length,
      kind,
      headingPath,
      headingSlug: headingPath ? slugifyHeading(headingPath.split(' > ').pop()!) : null,
      speaker: turn?.speaker ?? null,
      contextPrefix: contextPrefix(input, headingPath, turn?.speaker ?? null),
      body,
      anchorSubstring: anchorSource.trim().slice(0, 120),
      charStart: input.baseOffset + first.charStart,
      charEnd: input.baseOffset + last.charEnd,
      startLine: input.baseLine + first.line,
      tokenCount: acc.reduce((s, b) => s + b.tokens, 0),
    });
    acc = [];
  };

  let prevHeadingPath: string | null = null;
  for (const block of blocks) {
    const crossedSection = block.kind === 'header'
      || (block.headingPath !== prevHeadingPath && acc.length > 0);
    const tokens = acc.reduce((s, b) => s + b.tokens, 0);

    if (crossedSection) {
      flush();
    } else if (tokens + block.tokens > CHUNK_TARGET_TOKENS && acc.length > 0) {
      // Overlap: the last blocks (up to ~80 tokens) reopen the next chunk.
      const kept = acc;
      flush();
      const overlap: Block[] = [];
      let overlapTokens = 0;
      for (let j = kept.length - 1; j >= 0; j--) {
        if (overlapTokens + kept[j]!.tokens > CHUNK_OVERLAP_TOKENS) break;
        overlap.unshift(kept[j]!);
        overlapTokens += kept[j]!.tokens;
      }
      acc = overlap;
    }
    acc.push(block);
    prevHeadingPath = block.headingPath;
  }
  flush();
  return chunks;
}
