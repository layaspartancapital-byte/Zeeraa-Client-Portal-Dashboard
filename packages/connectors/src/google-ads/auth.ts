import { cloudProjectNumber, type GoogleAdsCredentials } from './types';

/**
 * OAuth for Google Ads: a stored refresh token, exchanged for short-lived
 * access tokens.
 *
 * There is no JWT bearer path here as there is for Salesforce. Google Ads does
 * not accept a service account except through Workspace domain-wide delegation,
 * which needs a Workspace domain that a client's ad account generally is not
 * behind. So the grant is a user's consent, captured once by
 * `scripts/google-ads-refresh-token.ts`, and that has a consequence worth
 * stating plainly: the connection breaks when that person loses access to the
 * account, changes their password, or removes the app from their Google
 * permissions. It is a dependency on a human, and it is reported as one.
 */

export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const ADWORDS_SCOPE = 'https://www.googleapis.com/auth/adwords';

export type GoogleAdsAccessToken = { accessToken: string; expiresAt: Date };

export type AuthFailure = {
  description: string;
  remedy: string;
  /**
   * Whether the fix belongs to the client. A revoked grant does; a malformed
   * request does not. Drives the `waiting_on_client` connection state (§9.5)
   * rather than a red failure the client cannot act on.
   */
  waitingOnClient: boolean;
};

export class GoogleAdsAuthError extends Error {
  constructor(readonly failure: AuthFailure) {
    super(failure.description);
    this.name = 'GoogleAdsAuthError';
  }
}

/**
 * Google's OAuth errors are a small set of opaque codes, and the difference
 * between them is entirely about who has to do something. `invalid_grant` in
 * particular reads like a bug and almost never is one.
 */
function explain(error: string, description: string | undefined): AuthFailure {
  switch (error) {
    case 'invalid_grant':
      return {
        description:
          'The refresh token is no longer valid. Google revokes it when the ' +
          'granting user loses access to the account, changes their password, ' +
          'or removes the app from their Google account permissions.',
        remedy:
          'Re-run `pnpm --filter @zeeraa/connectors google-ads-token`, signed in ' +
          'as a user with access to the manager account, and replace the stored ' +
          'refresh token. Nothing in the configuration needs to change.',
        waitingOnClient: true,
      };
    case 'invalid_client':
      return {
        description: 'Google rejected the OAuth client id or secret.',
        remedy:
          'Check the client id and secret against the Cloud project’s ' +
          'credentials. A client deleted and recreated in Cloud Console keeps ' +
          'the same display name and gets a new secret, which is the usual cause.',
        waitingOnClient: false,
      };
    case 'unauthorized_client':
      return {
        description:
          'The OAuth client is not authorised for this grant. Usually a Web ' +
          'application client being used where a Desktop app client is expected.',
        remedy:
          'Create a Desktop app OAuth client in the Cloud project and generate a ' +
          'new refresh token with it.',
        waitingOnClient: false,
      };
    default:
      return {
        description: `Google returned "${error}"${description ? `: ${description}` : ''}.`,
        remedy: 'Check the OAuth client and the refresh token against the Cloud project.',
        waitingOnClient: false,
      };
  }
}

/**
 * Exchanges the refresh token for an access token.
 *
 * Access tokens last an hour. The client caches one and re-mints it a minute
 * early rather than waiting for a 401, because a sync that discovers expiry
 * mid-pagination has to decide whether a partial page was written.
 */
export async function requestGoogleAdsAccessToken(
  credentials: GoogleAdsCredentials,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<GoogleAdsAccessToken> {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !body.access_token) {
    throw new GoogleAdsAuthError(
      explain(body.error ?? `http_${response.status}`, body.error_description),
    );
  }

  return {
    accessToken: body.access_token,
    expiresAt: new Date(now.getTime() + (body.expires_in ?? 3600) * 1000 - 60_000),
  };
}

/**
 * The headers every Google Ads REST call carries.
 *
 * `developer-token` is deliberately conditional. Google sunset developer tokens
 * on 9 September 2026: the header is now optional and ignored by their servers,
 * and the API access level is a property of the Google Cloud project behind the
 * OAuth client instead. It is still sent when a connection happens to hold one,
 * which costs nothing and keeps an older connection working unchanged, but its
 * absence is not a misconfiguration and nothing may infer an access level from
 * it — the level shown against a legacy token in the Ads API Center is
 * documented as possibly inaccurate.
 *
 * `login-customer-id` is required whenever the account is reached through a
 * manager account, which is Spartan's arrangement: their own MCC, not Zeeraa's.
 */
export function requestHeaders(
  accessToken: string,
  credentials: GoogleAdsCredentials,
  loginCustomerId?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
  };
  if (credentials.developerToken) headers['developer-token'] = credentials.developerToken;
  if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;
  return headers;
}

/**
 * Which Cloud project this connection's access level hangs off.
 *
 * Nothing in an API response names it, so when a call is refused for
 * access-level reasons this is the only way to tell somebody which project to
 * open in Cloud Console.
 */
export function accessLevelProject(credentials: GoogleAdsCredentials): string {
  const project = cloudProjectNumber(credentials.clientId);
  return project
    ? `Google Cloud project ${project} (from the OAuth client id)`
    : 'the Google Cloud project behind this OAuth client';
}
