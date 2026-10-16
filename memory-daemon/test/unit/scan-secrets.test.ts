import { describe, it, expect } from 'vitest';
import { scanSecrets, redact } from '../../src/security/scan-secrets.js';

describe('scanSecrets', () => {
  it('detects each secret family by prefix', () => {
    const cases: Array<[string, string]> = [
      ['sk-ant-api03-abcdefgh1234', 'secret.anthropic'],
      ['ghp_abcdefghijklmnopqrstuv123456', 'secret.github'],
      ['AKIAIOSFODNN7EXAMPLE', 'secret.aws'],
      // Placeholder shape on purpose: letters right after the prefix, so the
      // repo's pre-commit token guard (which demands a digit block there) does
      // not mistake the fixture for a real leaked token.
      ['xoxb-TESTTOKEN0-abcdefghij', 'secret.slack'],
      ['-----BEGIN RSA PRIVATE KEY-----', 'secret.privatekey'],
      ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456', 'secret.jwt'],
      ['postgres://user:supersecret1@db.example.com/prod', 'secret.connstring'],
    ];
    for (const [text, rule] of cases) {
      expect(scanSecrets(text).map((f) => f.rule), text).toContain(rule);
    }
  });

  it('a high-entropy assignment fires; a readable placeholder does not', () => {
    expect(scanSecrets('API_KEY = xK9mQ2vL8pR4tW7z').map((f) => f.rule)).toContain('secret.assignment');
    expect(scanSecrets('password = see_in_1password')).toEqual([]);
    expect(scanSecrets('the wifi password is with reception')).toEqual([]);
  });

  it('the finding NEVER echoes the secret: only a 4-char preview', () => {
    const [f] = scanSecrets('token ghp_abcdefghijklmnopqrstuv123456');
    expect(f!.preview).toBe('ghp_');
    expect(JSON.stringify(f)).not.toContain('abcdefghijklmnop');
  });

  it('redact replaces the value with [REDACTED:rule]', () => {
    const { text } = redact('key: sk-ant-api03-abcdefgh1234 end');
    expect(text).toContain('[REDACTED:secret.anthropic]');
    expect(text).not.toContain('sk-ant-api03');
  });

  it('an already-redacted line is CLEAN: the scanner never flags its own marker', () => {
    // The self-trigger loop of 2026-08-10: a correctly redacted transcript kept
    // the vault auto-commit blocked, because apiKey=[REDACTED:...] matches the
    // assignment shape and the marker text carries enough entropy.
    expect(scanSecrets('apiKey=[REDACTED:secret.assignment]')).toEqual([]);
    expect(scanSecrets('token: [REDACTED:secret.slack]')).toEqual([]);
  });

  it('redact is idempotent: a second pass changes nothing', () => {
    const once = redact('API_KEY = xK9mQ2vL8pR4tW7z and key: sk-ant-api03-abcdefgh1234').text;
    expect(redact(once).text).toBe(once);
    expect(scanSecrets(once)).toEqual([]);
  });
});
