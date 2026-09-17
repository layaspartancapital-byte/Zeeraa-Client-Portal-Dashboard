import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { decryptCredentials, encryptCredentials } from '../src/encryption';

const secret = randomBytes(32);

describe('credential encryption', () => {
  it('round-trips a credential object', () => {
    const creds = { clientId: '3MVG9', username: 'svc@example.com', refreshToken: 'abc' };
    expect(decryptCredentials(encryptCredentials(creds, secret), secret)).toEqual(creds);
  });

  it('produces a different ciphertext every time', () => {
    // A deterministic ciphertext would leak which tenants share a credential.
    const a = encryptCredentials({ token: 'same' }, secret);
    const b = encryptCredentials({ token: 'same' }, secret);
    expect(a).not.toBe(b);
  });

  it('refuses a tampered ciphertext rather than returning rubbish', () => {
    const blob = encryptCredentials({ token: 'secret' }, secret);
    const parts = blob.split('.');
    const flipped = Buffer.from(parts[3]!, 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    parts[3] = flipped.toString('base64url');
    expect(() => decryptCredentials(parts.join('.'), secret)).toThrow();
  });

  it('refuses the wrong key', () => {
    expect(() => decryptCredentials(encryptCredentials({ a: 1 }, secret), randomBytes(32))).toThrow();
  });

  it('rejects a malformed blob by shape, not by crashing mid-decrypt', () => {
    expect(() => decryptCredentials('not-a-blob', secret)).toThrow(/expected v1 format/i);
  });

  it('names the problem when the key is the wrong length', () => {
    const saved = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = Buffer.from('too short').toString('base64');
    expect(() => encryptCredentials({ a: 1 })).toThrow(/must decode to 32 bytes/i);
    process.env.ENCRYPTION_KEY = saved;
  });
});
