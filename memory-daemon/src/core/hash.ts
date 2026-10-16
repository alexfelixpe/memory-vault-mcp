import crypto from 'node:crypto';
import { canonicalize } from './text/canonicalize.js';

/** sha256 hex of an already-prepared string (without canonicalizing again). */
export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Canonical hash of file content: sha256 over canonicalize(). */
export function contentHash(raw: string): string {
  return sha256(canonicalize(raw));
}
