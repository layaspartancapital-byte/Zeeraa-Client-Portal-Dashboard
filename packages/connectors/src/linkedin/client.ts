import {
  LINKEDIN_API_VERSION,
  LINKEDIN_SCOPES,
  type LinkedInCredentials,
  type LinkedInDate,
  type LinkedInTokenResponse,
} from './types';

const API = 'https://api.linkedin.com/rest';
const AUTHORIZE = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN = 'https://www.linkedin.com/oauth/v2/accessToken';

export class LinkedInApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly code: string | null,
    readonly detail: string,
  ) {
    super(`LinkedIn ${status} on ${path}: ${detail}`);
    this.name = 'LinkedInApiError';
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }

  /** A lapsed or revoked grant, or a member without access to the account. */
  get waitingOnClient(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export type LinkedInApp = { clientId: string; clientSecret: string };

/** The app's credentials, from the environment. Throws naming what is missing. */
export function linkedInAppFromEnv(env: NodeJS.ProcessEnv = process.env): LinkedInApp {
  const clientId = env.LINKEDIN_CLIENT_ID ?? '';
  const clientSecret = env.LINKEDIN_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) {
    throw new Error('LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET must both be set.');
  }
  return { clientId, clientSecret };
}

/** Where the member is sent to grant `r_ads` and `r_ads_reporting`. */
export function linkedInAuthorizeUrl(app: LinkedInApp, redirectUri: string, state: string): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: app.clientId,
    redirect_uri: redirectUri,
    state,
    scope: LINKEDIN_SCOPES.join(' '),
  });
  return `${AUTHORIZE}?${query}`;
}

export type LinkedInGrant = Pick<
  LinkedInCredentials,
  'accessToken' | 'accessTokenExpiresAt' | 'refreshToken' | 'refreshTokenExpiresAt' | 'scope'
>;

function grantFrom(body: LinkedInTokenResponse, now: Date, previous?: LinkedInGrant): LinkedInGrant {
  const at = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();
  return {
    accessToken: body.access_token,
    accessTokenExpiresAt: at(body.expires_in),
    refreshToken: body.refresh_token ?? previous?.refreshToken ?? null,
    refreshTokenExpiresAt:
      body.refresh_token_expires_in !== undefined
        ? at(body.refresh_token_expires_in)
        : (previous?.refreshTokenExpiresAt ?? null),
    scope: body.scope ?? previous?.scope ?? '',
  };
}

async function tokenRequest(
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<LinkedInTokenResponse> {
  const res = await fetchImpl(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // fall through: reported below
  }
  if (!res.ok || typeof body.access_token !== 'string') {
    const detail = String(body.error_description ?? body.error ?? text.slice(0, 200));
    throw new LinkedInApiError(res.status, '/oauth/v2/accessToken', String(body.error ?? '') || null, detail);
  }
  return body as unknown as LinkedInTokenResponse;
}

/** The code from the callback, for the member's tokens. */
export async function exchangeLinkedInCode(
  app: LinkedInApp,
  code: string,
  redirectUri: string,
  options: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<LinkedInGrant> {
  const body = await tokenRequest(
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: app.clientId,
      client_secret: app.clientSecret,
    },
    options.fetchImpl ?? fetch,
  );
  return grantFrom(body, options.now ?? new Date());
}

/**
 * A fresh access token from the refresh token.
 *
 * Nothing is written back. The ingestion role cannot update `connections` —
 * a connector must not be able to rewrite its own credentials — and it does
 * not need to: the refresh token's expiry is fixed at the grant and a refresh
 * leaves it unchanged, so the stored grant stays exactly as good. After the
 * access token's 60 days, each run mints one in memory.
 */
export async function refreshLinkedInToken(
  app: LinkedInApp,
  grant: LinkedInGrant,
  options: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<LinkedInGrant> {
  if (!grant.refreshToken) {
    throw new LinkedInApiError(401, '/oauth/v2/accessToken', 'no_refresh_token', 'The grant has no refresh token. Reconnect LinkedIn.');
  }
  const body = await tokenRequest(
    {
      grant_type: 'refresh_token',
      refresh_token: grant.refreshToken,
      client_id: app.clientId,
      client_secret: app.clientSecret,
    },
    options.fetchImpl ?? fetch,
  );
  return grantFrom(body, options.now ?? new Date(), grant);
}

/** Rest.li's date literal: `(year:2026,month:9,day:1)`. */
export function restliDate(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return `(year:${year},month:${month},day:${date})`;
}

export function fromLinkedInDate(d: LinkedInDate | undefined): string | null {
  if (!d || !d.year || !d.month || !d.day) return null;
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

export class LinkedInClient {
  constructor(
    private readonly accessToken: string,
    private readonly apiVersion: string = LINKEDIN_API_VERSION,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * A GET against the versioned REST API. `query` is sent verbatim: Rest.li
   * reads `List(...)` and `(start:(...))` structurally, so those characters
   * must not be percent-encoded, while a URN inside them must be.
   */
  async get<T>(path: string, query = ''): Promise<T> {
    const url = `${API}${path}${query ? `?${query}` : ''}`;
    const res = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'linkedin-version': this.apiVersion,
        'x-restli-protocol-version': '2.0.0',
      },
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new LinkedInApiError(res.status, path, null, `not JSON: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const code = typeof body.code === 'string' ? body.code : body.serviceErrorCode ? String(body.serviceErrorCode) : null;
      throw new LinkedInApiError(res.status, path, code, String(body.message ?? text.slice(0, 200)));
    }
    return body as T;
  }

  /** Every element of a cursor-paged finder (`pageToken`), up to `maxPages`. */
  async all<T>(path: string, query: string, maxPages = 50): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const q = `${query}&pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
      const body = await this.get<{ elements?: T[]; metadata?: { nextPageToken?: string } }>(path, q);
      out.push(...(body.elements ?? []));
      token = body.metadata?.nextPageToken;
      if (!token) return out;
    }
    throw new Error(`LinkedIn ${path}: more than ${maxPages} pages.`);
  }
}

/** A sponsored account's URN, encoded for use inside `List(...)`. */
export function accountUrn(adAccountId: string): string {
  return encodeURIComponent(`urn:li:sponsoredAccount:${adAccountId}`);
}

/** The numeric id at the end of a URN, e.g. `urn:li:sponsoredCampaign:123` → `123`. */
export function urnId(urn: string | undefined): string | null {
  const m = /:(\d+)$/.exec(urn ?? '');
  return m ? m[1]! : null;
}

/** Whether an access token will still be good in five minutes. */
export function accessTokenUsable(grant: Pick<LinkedInGrant, 'accessTokenExpiresAt'>, now = new Date()): boolean {
  return new Date(grant.accessTokenExpiresAt).getTime() - now.getTime() > 5 * 60_000;
}
