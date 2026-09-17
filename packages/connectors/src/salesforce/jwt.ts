import { createSign } from 'node:crypto';

/**
 * Salesforce JWT bearer flow.
 *
 * No consent screen and no refresh token: the integration user is
 * pre-authorized on the connected app via a permission set, and every token
 * request is a fresh signed assertion. That is the right shape for a server
 * integration, and it fails in ways that are famously unhelpful — see
 * `explainTokenFailure` below, which turns each one back into the thing you
 * actually have to go and change.
 */

export type JwtConfig = {
  /** Consumer key of the connected app. */
  clientId: string;
  /** The integration user's username — the `sub` claim, not an email alias. */
  username: string;
  /**
   * PEM private key, base64-encoded.
   *
   * Base64 because a PEM is multi-line and environment variables mangle
   * newlines — in Codespaces secrets, in Vercel's dashboard, in a .env parsed
   * by three different libraries. Encoding it once removes the whole class of
   * problem, at the cost of one decode here.
   */
  privateKeyBase64: string;
  /**
   * `https://login.salesforce.com` for production, `https://test.salesforce.com`
   * for a sandbox. Per connection, not per deployment: one Zeeraa instance will
   * eventually talk to one client's sandbox and another's production org.
   */
  loginUrl: string;
};

export type AccessToken = {
  accessToken: string;
  /** Org-specific host. Every subsequent API call goes here, not to loginUrl. */
  instanceUrl: string;
  issuedAt: Date;
  scope?: string;
};

export function decodePrivateKey(privateKeyBase64: string): string {
  const pem = Buffer.from(privateKeyBase64.trim(), 'base64').toString('utf8').trim();
  if (!pem.includes('-----BEGIN')) {
    throw new Error(
      'SF_PRIVATE_KEY_BASE64 did not decode to a PEM private key. Encode the ' +
        'whole .key file: base64 -w0 server.key',
    );
  }
  return pem;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Builds and signs the assertion.
 *
 * `exp` is deliberately short. Salesforce rejects an assertion whose expiry is
 * more than a few minutes out, and a long-lived signed assertion is a
 * credential in its own right — it should not outlive the request that needs it.
 */
export function buildAssertion(config: JwtConfig, now: Date = new Date()): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: config.clientId,
      sub: config.username,
      aud: config.loginUrl,
      exp: Math.floor(now.getTime() / 1000) + 180,
    }),
  );

  const signingInput = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = base64url(signer.sign(decodePrivateKey(config.privateKeyBase64)));

  return `${signingInput}.${signature}`;
}

export type TokenFailure = {
  error: string;
  description: string;
  /** What to change, rather than what went wrong. */
  remedy: string;
  /** True where the fix is in the client's Salesforce org, not in this code. */
  waitingOnClient: boolean;
};

/**
 * Turns Salesforce's token errors into something actionable.
 *
 * Every one of these is a configuration fact about the org, and each one
 * arrives as a two-word string that tells you nothing. `invalid_grant: user
 * hasn't approved this consumer` in particular does not mean the user needs to
 * approve anything — it means the profile or permission set was never
 * pre-authorized on the connected app, which is a different screen entirely.
 */
export function explainTokenFailure(error: string, description: string): TokenFailure {
  const d = description.toLowerCase();

  if (d.includes("user hasn't approved this consumer") || d.includes('not approved')) {
    return {
      error,
      description,
      remedy:
        'The integration user is not pre-authorized on the connected app. In ' +
        'Setup → App Manager → the connected app → Manage → Edit Policies, set ' +
        'Permitted Users to "Admin approved users are pre-authorized", then ' +
        'assign the user’s profile or a permission set to the app. JWT skips ' +
        'the consent screen, so without this it can never succeed.',
      waitingOnClient: true,
    };
  }

  if (d.includes('ip restricted') || d.includes('inactive user') || d.includes('restricted ip')) {
    return {
      error,
      description,
      remedy:
        'The integration user’s profile enforces IP ranges, and Vercel egress ' +
        'addresses are not static. Relax the login IP ranges on that profile, or ' +
        'set the connected app’s IP Relaxation to "Relax IP restrictions".',
      waitingOnClient: true,
    };
  }

  if (d.includes('invalid assertion') || d.includes('invalid signature')) {
    return {
      error,
      description,
      remedy:
        'The signature did not verify against the certificate on the connected ' +
        'app. Either SF_PRIVATE_KEY_BASE64 is not the key matching the uploaded ' +
        'certificate, or the decoded PEM is corrupt. Check it decodes to a ' +
        'PEM beginning "-----BEGIN".',
      waitingOnClient: false,
    };
  }

  if (d.includes('audience')) {
    return {
      error,
      description,
      remedy:
        'The `aud` claim does not match the org. Use https://login.salesforce.com ' +
        'for production and https://test.salesforce.com for a sandbox — this is ' +
        'per connection, and a sandbox refresh silently changes which one is right.',
      waitingOnClient: false,
    };
  }

  if (error === 'invalid_client_id' || d.includes('client identifier')) {
    return {
      error,
      description,
      remedy:
        'SF_CLIENT_ID is not a consumer key this org recognises. Confirm it ' +
        'against the connected app, and that the app is installed in the org ' +
        'being addressed.',
      waitingOnClient: false,
    };
  }

  if (d.includes('user hasn’t') || d.includes('invalid_grant')) {
    return {
      error,
      description,
      remedy:
        'Usually the `sub` claim: it must be the integration user’s Salesforce ' +
        'username, which is not necessarily their email address.',
      waitingOnClient: false,
    };
  }

  return {
    error,
    description,
    remedy: 'Unrecognised token failure. The raw response is preserved above.',
    waitingOnClient: false,
  };
}

export class SalesforceAuthError extends Error {
  readonly failure: TokenFailure;
  constructor(failure: TokenFailure) {
    super(`Salesforce auth failed (${failure.error}): ${failure.description}\n\n${failure.remedy}`);
    this.name = 'SalesforceAuthError';
    this.failure = failure;
  }
}

export async function requestAccessToken(
  config: JwtConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessToken> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: buildAssertion(config),
  });

  const response = await fetchImpl(`${config.loginUrl.replace(/\/$/, '')}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, string>;

  if (!response.ok) {
    throw new SalesforceAuthError(
      explainTokenFailure(payload.error ?? String(response.status), payload.error_description ?? ''),
    );
  }

  if (!payload.access_token || !payload.instance_url) {
    throw new SalesforceAuthError(
      explainTokenFailure('malformed_response', JSON.stringify(payload).slice(0, 300)),
    );
  }

  return {
    accessToken: payload.access_token,
    instanceUrl: payload.instance_url,
    issuedAt: new Date(),
    scope: payload.scope,
  };
}
