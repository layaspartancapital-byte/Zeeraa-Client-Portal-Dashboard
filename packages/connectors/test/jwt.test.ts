/**
 * These tests are genuinely offline. They generate a key pair, build an
 * assertion and verify it the way Salesforce would — signature, claims, expiry.
 * That proves the assertion is well-formed. It proves nothing about whether any
 * particular org will accept it, which depends on facts about that org.
 */
import { describe, expect, it } from 'vitest';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  buildAssertion,
  decodePrivateKey,
  explainTokenFailure,
  requestAccessToken,
  SalesforceAuthError,
  type JwtConfig,
} from '../src/salesforce/jwt';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const config: JwtConfig = {
  clientId: '3MVG9.consumer.key',
  username: 'integration@spartancapitalgroup.com.zeeraa',
  privateKeyBase64: Buffer.from(privateKey).toString('base64'),
  loginUrl: 'https://login.salesforce.com',
};

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
}

describe('the private key', () => {
  it('survives a round trip through base64', () => {
    expect(decodePrivateKey(config.privateKeyBase64)).toBe(privateKey.trim());
  });

  it('tolerates the whitespace an env var picks up', () => {
    expect(decodePrivateKey(`  ${config.privateKeyBase64}\n`)).toBe(privateKey.trim());
  });

  it('says what is wrong when the variable holds a raw PEM instead of base64', () => {
    // The mistake this catches: pasting the PEM directly, which "works" until
    // the newlines are eaten somewhere between the dashboard and the runtime.
    expect(() => decodePrivateKey(privateKey)).toThrow(/did not decode to a PEM/i);
  });
});

describe('the assertion', () => {
  it('carries the claims Salesforce checks', () => {
    const now = new Date('2026-09-17T12:00:00Z');
    const [, claims] = buildAssertion(config, now).split('.');
    expect(decodeSegment(claims!)).toEqual({
      iss: config.clientId,
      sub: config.username,
      aud: 'https://login.salesforce.com',
      exp: Math.floor(now.getTime() / 1000) + 180,
    });
  });

  it('expires within the window Salesforce accepts', () => {
    const now = new Date();
    const [, claims] = buildAssertion(config, now).split('.');
    const exp = decodeSegment(claims!).exp as number;
    const seconds = exp - Math.floor(now.getTime() / 1000);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(300);
  });

  it('verifies against the matching public key', () => {
    const token = buildAssertion(config);
    const [header, claims, signature] = token.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${claims}`);
    verifier.end();
    expect(
      verifier.verify(publicKey, Buffer.from(signature!.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    ).toBe(true);
  });

  it('does not verify against a different key', () => {
    const other = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const [header, claims, signature] = buildAssertion(config).split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${claims}`);
    verifier.end();
    expect(
      verifier.verify(
        other.publicKey,
        Buffer.from(signature!.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
      ),
    ).toBe(false);
  });

  it('addresses a sandbox when the connection says so', () => {
    const [, claims] = buildAssertion({
      ...config,
      loginUrl: 'https://test.salesforce.com',
    }).split('.');
    expect(decodeSegment(claims!).aud).toBe('https://test.salesforce.com');
  });
});

describe('token failures', () => {
  it('reads the approval error as the configuration fact it is', () => {
    const f = explainTokenFailure('invalid_grant', "user hasn't approved this consumer");
    expect(f.waitingOnClient).toBe(true);
    expect(f.remedy).toMatch(/pre-authorized/i);
    expect(f.remedy).toMatch(/permission set/i);
  });

  it('recognises IP restriction, which Vercel will always trip', () => {
    const f = explainTokenFailure('invalid_grant', 'inactive user or IP restricted');
    expect(f.waitingOnClient).toBe(true);
    expect(f.remedy).toMatch(/IP/);
  });

  it('separates our problems from the client’s', () => {
    expect(explainTokenFailure('invalid_grant', 'invalid assertion').waitingOnClient).toBe(false);
    expect(explainTokenFailure('invalid_client_id', '').waitingOnClient).toBe(false);
  });
});

describe('requestAccessToken', () => {
  it('returns the instance url, which is where every later call goes', async () => {
    const stub = (async () =>
      new Response(
        JSON.stringify({
          access_token: 'tok',
          instance_url: 'https://spartan.my.salesforce.com',
          scope: 'api refresh_token',
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const token = await requestAccessToken(config, stub);
    expect(token.instanceUrl).toBe('https://spartan.my.salesforce.com');
    expect(token.accessToken).toBe('tok');
  });

  it('raises the explained failure rather than the raw error', async () => {
    const stub = (async () =>
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: "user hasn't approved this consumer",
        }),
        { status: 400 },
      )) as unknown as typeof fetch;

    await expect(requestAccessToken(config, stub)).rejects.toThrow(SalesforceAuthError);
    await expect(requestAccessToken(config, stub)).rejects.toThrow(/pre-authorized/i);
  });
});
