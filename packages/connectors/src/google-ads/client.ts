import {
  accessLevelProject,
  requestGoogleAdsAccessToken,
  requestHeaders,
  type GoogleAdsAccessToken,
} from './auth';
import { normalizeCustomerId } from './gaql';
import {
  DEFAULT_API_VERSION,
  type GoogleAdsConfig,
  type GoogleAdsCredentials,
  type GoogleAdsRow,
} from './types';

/**
 * A small REST client for GAQL.
 *
 * `searchStream` rather than `search`: it returns the whole result set as a
 * sequence of chunks with no page tokens, which suits a report pull and removes
 * a class of bug where a paginated loop half-completes and writes a partial
 * day. Paging exists for interactive use; ingestion wants all or nothing.
 */

export class GoogleAdsApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
    /** Google's own request id, from the response header. Quote it to support. */
    readonly requestId: string | null,
    /** Whether retrying the identical request could plausibly succeed. */
    readonly retryable: boolean,
  ) {
    super(`Google Ads API ${status} on ${path}: ${body}`);
    this.name = 'GoogleAdsApiError';
  }
}

/** Refused for reasons no retry fixes — the Cloud project's access level. */
export class GoogleAdsAccessError extends Error {
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(message);
    this.name = 'GoogleAdsAccessError';
  }
}

export class GoogleAdsClient {
  private token?: GoogleAdsAccessToken;

  constructor(
    private readonly credentials: GoogleAdsCredentials,
    private readonly config: GoogleAdsConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get version(): string {
    return this.config.apiVersion ?? DEFAULT_API_VERSION;
  }

  private get customerId(): string {
    return normalizeCustomerId(this.config.customerId);
  }

  async accessToken(now: Date = new Date()): Promise<string> {
    if (!this.token || this.token.expiresAt <= now) {
      this.token = await requestGoogleAdsAccessToken(this.credentials, this.fetchImpl, now);
    }
    return this.token.accessToken;
  }

  /**
   * Runs one GAQL query and returns every row.
   *
   * `searchStream` responds with a JSON array of chunks, each holding a
   * `results` array; a query matching nothing returns an empty array rather
   * than an error, which is a real result and not a failure.
   */
  async search(query: string): Promise<GoogleAdsRow[]> {
    const path = `/${this.version}/customers/${this.customerId}/googleAds:searchStream`;
    const token = await this.accessToken();

    const response = await this.fetchImpl(`https://googleads.googleapis.com${path}`, {
      method: 'POST',
      headers: requestHeaders(token, this.credentials, this.loginCustomerId()),
      body: JSON.stringify({ query }),
    });

    const requestId = response.headers?.get?.('request-id') ?? null;

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.raise(response.status, path, body, requestId);
    }

    const payload = (await response.json()) as
      | { results?: GoogleAdsRow[] }[]
      | { results?: GoogleAdsRow[] };

    const chunks = Array.isArray(payload) ? payload : [payload];
    return chunks.flatMap((chunk) => chunk.results ?? []);
  }

  private loginCustomerId(): string | undefined {
    return this.config.loginCustomerId
      ? normalizeCustomerId(this.config.loginCustomerId)
      : undefined;
  }

  /**
   * Turns an HTTP failure into the right kind of error.
   *
   * The distinction that matters is retryable versus not. A 429 or a 503 is
   * worth another attempt; an access-level refusal is worth a message naming
   * the Cloud project, because retrying it every hour for a week is how a
   * blocked integration looks like a flaky one.
   */
  private raise(status: number, path: string, body: string, requestId: string | null): never {
    const lower = body.toLowerCase();

    if (
      lower.includes('developer_token_not_approved') ||
      lower.includes('not_adwords_user') ||
      lower.includes('customer_not_enabled') ||
      (status === 403 && lower.includes('access'))
    ) {
      throw new GoogleAdsAccessError(
        `Google Ads refused the request for access reasons (${status}): ${body.slice(0, 300)}`,
        `Since 9 September 2026 the API access level belongs to the Cloud project, not ` +
          `to a developer token. Check ${accessLevelProject(this.credentials)} — open its ` +
          'Google Ads API Overview page in Cloud Console and look at the access level ' +
          'there. A project at Test level can only query test accounts, and the level ' +
          'shown in the Ads API Center against a legacy developer token is documented ' +
          'as possibly inaccurate, so do not read it from there.',
      );
    }

    // 429 is quota. 5xx is Google. Both are worth another attempt; a 400 is a
    // query this code built wrong and will build wrong again.
    const retryable = status === 429 || status >= 500;
    throw new GoogleAdsApiError(status, path, body.slice(0, 500), requestId, retryable);
  }
}
