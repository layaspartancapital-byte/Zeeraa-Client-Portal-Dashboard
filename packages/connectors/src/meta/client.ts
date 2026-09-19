import { DEFAULT_API_VERSION, type MetaConfig, type MetaCredentials } from './types';

/**
 * A small REST client for the Graph API.
 *
 * Three things about Meta that shape this file:
 *
 * 1. **Every error is HTTP 400 with a body that says what really happened.**
 *    The status tells you nothing; `error.code` and `error.error_subcode` tell
 *    you whether to retry, to wait, or to go and ask the client to re-authorise.
 *    Classifying on status alone would retry a revoked token forever and give
 *    up on a rate limit.
 * 2. **Paging is by opaque cursor**, and the `paging.next` URL carries the
 *    query but not the credential, because the token travels in a header here
 *    rather than in the query string. Following `next` with the same header is
 *    correct; rebuilding the query from cursors is not necessary.
 * 3. **Insights can refuse a large request** and tell you to submit it as an
 *    async job. At campaign grain over ninety days this account returns 102
 *    rows in one call, so the async path is not built — but the refusal is
 *    detected and named, because a silent empty result would read as a quiet
 *    month rather than as a query that was never run.
 */

export class MetaApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    /** Meta's own error code. This, not the HTTP status, is the signal. */
    readonly code: number | null,
    readonly subcode: number | null,
    readonly type: string | null,
    /** Quote this to Meta support. */
    readonly traceId: string | null,
    readonly detail: string,
  ) {
    super(`Meta API ${status} on ${path}: ${detail}`);
    this.name = 'MetaApiError';
  }

  /** Transient: the identical request could succeed later. */
  get retryable(): boolean {
    return RATE_LIMIT_CODES.has(this.code ?? -1) || this.status >= 500;
  }

  /**
   * The remedy is the client's, not ours — a revoked token, a system user
   * removed from the business, a permission taken away, or an ad account that
   * has been disabled. None of these is fixed by retrying or by changing code.
   */
  get waitingOnClient(): boolean {
    return AUTH_CODES.has(this.code ?? -1) || PERMISSION_CODES.has(this.code ?? -1);
  }

  /** Meta wants this submitted as an async insights job instead. */
  get needsAsyncJob(): boolean {
    return this.code === 1 && /reduce the amount of data/i.test(this.detail);
  }
}

/** 4 and 17 are app- and user-level throttles; 32 is page-level; 613 custom. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80000, 80004]);
/** 102 and 190 are session/token problems. */
const AUTH_CODES = new Set([102, 190]);
/** 3, 10 and 200–299 are "this token may not do that". */
const PERMISSION_CODES = new Set([3, 10, 200, 272, 294]);

export type MetaPage<T> = { data: T[]; paging?: { next?: string } };

export class MetaClient {
  constructor(
    private readonly credentials: MetaCredentials,
    private readonly config: MetaConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get version(): string {
    return this.config.apiVersion ?? DEFAULT_API_VERSION;
  }

  /** `act_` prefixed, however the id was configured. */
  get account(): string {
    const id = String(this.config.adAccountId).trim();
    return id.startsWith('act_') ? id : `act_${id}`;
  }

  private async request<T>(url: string, path: string): Promise<MetaPage<T>> {
    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${this.credentials.accessToken}`,
        accept: 'application/json',
      },
    });

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new MetaApiError(response.status, path, null, null, null, null, text.slice(0, 500));
    }

    const error = (body as { error?: Record<string, unknown> }).error;
    if (error) {
      throw new MetaApiError(
        response.status,
        path,
        typeof error.code === 'number' ? error.code : null,
        typeof error.error_subcode === 'number' ? error.error_subcode : null,
        typeof error.type === 'string' ? error.type : null,
        typeof error.fbtrace_id === 'string' ? error.fbtrace_id : null,
        String(error.message ?? text.slice(0, 500)),
      );
    }
    if (!response.ok) {
      throw new MetaApiError(response.status, path, null, null, null, null, text.slice(0, 500));
    }

    return body as MetaPage<T>;
  }

  /** A single node read — no `data` array, no paging. */
  async node<T>(edge: string, params: Record<string, string>): Promise<T> {
    const path = `/${this.version}/${edge}`;
    const url = `https://graph.facebook.com${path}?${new URLSearchParams(params).toString()}`;
    return (await this.request<never>(url, path)) as unknown as T;
  }

  /**
   * Every page of an edge.
   *
   * `maxPages` is a stop, not a tuning knob: a cursor loop that never
   * terminates because the API keeps handing back a `next` is a job that runs
   * until the function times out, and it should say so instead.
   */
  async edge<T>(
    edge: string,
    params: Record<string, string>,
    maxPages = 50,
  ): Promise<T[]> {
    const path = `/${this.version}/${edge}`;
    let url = `https://graph.facebook.com${path}?${new URLSearchParams(params).toString()}`;
    const out: T[] = [];

    for (let page = 0; page < maxPages; page += 1) {
      const body = await this.request<T>(url, path);
      out.push(...(body.data ?? []));
      const next = body.paging?.next;
      if (!next) return out;
      url = next;
    }

    throw new MetaApiError(
      200,
      path,
      null,
      null,
      null,
      null,
      `Stopped after ${maxPages} pages; the cursor never ended. Narrow the ` +
        'window rather than raising the cap.',
    );
  }
}
