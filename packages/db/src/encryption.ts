import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for the `connections.credentials` blob.
 *
 * Per-tenant OAuth and Slack tokens live in that column rather than in
 * environment variables, so onboarding a client never needs a redeploy (§14) —
 * which means the column holds every client's credentials at once and has to be
 * encrypted at rest with a key the database does not have.
 *
 * GCM rather than CBC: it authenticates as well as encrypts, so a tampered
 * ciphertext fails loudly instead of decrypting to plausible rubbish.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

function key(): Buffer {
  const encoded = process.env.ENCRYPTION_KEY;
  if (!encoded) throw new Error('ENCRYPTION_KEY is not set.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to 32 bytes, got ${bytes.length}. ` +
        'Generate one with: openssl rand -base64 32',
    );
  }
  return bytes;
}

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url. Versioned so the key can rotate. */
export function encryptCredentials(value: unknown, secret: Buffer = key()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, secret, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptCredentials<T = Record<string, unknown>>(
  blob: string,
  secret: Buffer = key(),
): T {
  const [version, iv, tag, ciphertext] = blob.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) {
    throw new Error('Credential blob is not in the expected v1 format.');
  }
  const decipher = createDecipheriv(ALGORITHM, secret, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}
