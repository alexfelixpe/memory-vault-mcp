/**
 * Secret scan (section 10 of the plan). Blocks in ALL layers, including the
 * reservoir: a false negative here is irreversible (a secret published to
 * Git). High-precision rules by prefix; entropy only on a line that already
 * has an assignment shape, never in prose. The returned error NEVER echoes the
 * value: only rule, line and the first 4 chars.
 */

interface SecretRule {
  id: string;
  re: RegExp;
}

const RULES: SecretRule[] = [
  { id: 'secret.anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{8,}/ },
  { id: 'secret.openai', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { id: 'secret.github', re: /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { id: 'secret.aws', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'secret.slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'secret.privatekey', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'secret.jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { id: 'secret.connstring', re: /\b\w+:\/\/[^\s:@/]+:[^\s:@/]{6,}@[\w.-]+/ },
];

// Assignment SECRET|TOKEN|PASSWORD|API_KEY = value: matches the SHAPE; the
// value's entropy decides (avoids blocking PASSWORD = see_in_1password).
const ASSIGNMENT_RE = /\b(secret|token|password|senha|api[_-]?key|apikey)\b\s*[:=]\s*["']?([^\s"']{8,})["']?/i;

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export interface SecretFinding {
  rule: string;
  /** 1-based line in the scanned text. */
  line: number;
  /** Only the first 4 chars of the value: the error never echoes the secret. */
  preview: string;
}

export function scanSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (m) findings.push({ rule: rule.id, line: i + 1, preview: m[0].slice(0, 4) });
    }
    const asg = ASSIGNMENT_RE.exec(line);
    // 3.7: above readable snake_case phrases, below a real random key.
    // A value that IS a redaction marker is the scanner's own past output, not
    // a secret. Without this guard the scanner flags every line it already
    // redacted, and the vault auto-commit stays blocked forever on transcripts
    // that were handled correctly (found 2026-08-10, 10 days of blocked
    // backup commits).
    if (asg && !asg[2]!.startsWith('[REDACTED:') && shannonEntropy(asg[2]!) >= 3.7) {
      findings.push({ rule: 'secret.assignment', line: i + 1, preview: asg[2]!.slice(0, 4) });
    }
  }
  return findings;
}

/** Masks the findings: the value becomes [REDACTED:rule]. Used in transcripts. */
export function redact(text: string): { text: string; findings: SecretFinding[] } {
  const findings = scanSecrets(text);
  let out = text;
  for (const rule of RULES) {
    out = out.replace(new RegExp(rule.re.source, rule.re.flags + 'g'), `[REDACTED:${rule.id}]`);
  }
  out = out.replace(new RegExp(ASSIGNMENT_RE.source, 'gi'), (full, key: string, value: string) =>
    // Same marker guard as the scan: replacing a marker with a marker would be
    // harmless once, but it makes redact() honestly idempotent.
    !value.startsWith('[REDACTED:') && shannonEntropy(value) >= 3.7
      ? `${key}=[REDACTED:secret.assignment]`
      : full);
  return { text: out, findings };
}
