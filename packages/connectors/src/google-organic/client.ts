import { requestGoogleAdsAccessToken, type GoogleAdsAccessToken } from '../google-ads/auth';
import type { GoogleOrganicCredentials } from './types';

/**
 * A small JSON client for the two Google APIs that are not Google Ads.
 *
 * It mints its access token through the same code path the Ads connector uses,
 * because it is the same refresh token — one consent, three APIs. That is also
 * the failure mode worth naming: a refresh token carries the scopes it was
 * granted and never gains more, so a token issued for `adwords` alone answers
 * every GA4 and Search Console call with 403
 * `ACCESS_TOKEN_SCOPE_INSUFFICIENT`. That error is indistinguishable at a
 * glance from a disabled API or a property the user cannot see, so it is
 * detected and named here rather than surfaced as a bare 403.
 */

export class GoogleOrganicApiError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly reason: string | null,
    readonly detail: string,
  ) {
    super(`Google API ${status} on ${url}: ${detail}`);
    this.name = 'GoogleOrganicApiError';
  }

  /** The token lacks the scope this API needs. No retry fixes it. */
  get scopeInsufficient(): boolean {
    return this.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT';
  }

  /** The API is not enabled on the Cloud project behind the OAuth client. */
  get serviceDisabled(): boolean {
    return this.reason === 'SERVICE_DISABLED';
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }

  /** The remedy is the client's: consent, property access, or a Cloud setting. */
  get waitingOnClient(): boolean {
    return this.scopeInsufficient || this.serviceDisabled || this.status === 403;
  }
}

export class GoogleOrganicClient {
  private token?: GoogleAdsAccessToken;

  constructor(
    private readonly credentials: GoogleOrganicCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async accessToken(now: Date = new Date()): Promise<string> {
    if (!this.token || this.token.expiresAt <= now) {
      this.token = await requestGoogleAdsAccessToken(this.credentials, this.fetchImpl, now);
    }
    return this.token.accessToken;
  }

  async post<T>(url: string, body: unknown): Promise<T> {
    return this.request<T>(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async get<T>(url: string): Promise<T> {
    return this.request<T>(url, { method: 'GET' });
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const token = await this.accessToken();
    const response = await this.fetchImpl(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
    });

    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new GoogleOrganicApiError(response.status, url, null, text.slice(0, 400));
    }

    const error = (body as { error?: { message?: string; details?: { reason?: string }[] } }).error;
    if (error) {
      // The machine-readable reason is in `details[].reason`; the message alone
      // says "Request had insufficient authentication scopes" for a scope
      // problem and something similar for three other causes.
      const reason = error.details?.find((d) => d.reason)?.reason ?? null;
      throw new GoogleOrganicApiError(
        response.status,
        url,
        reason,
        error.message ?? text.slice(0, 400),
      );
    }
    if (!response.ok) {
      throw new GoogleOrganicApiError(response.status, url, null, text.slice(0, 400));
    }

    return body as T;
  }
}
