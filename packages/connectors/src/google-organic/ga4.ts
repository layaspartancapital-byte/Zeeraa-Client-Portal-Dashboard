import type { DateRange } from '@zeeraa/core';
import { GoogleOrganicApiError, GoogleOrganicClient } from './client';
import { GA4_API, GA4_SCOPE, type Ga4Config, type Ga4Row } from './types';

/**
 * GA4, through the Data API.
 *
 * Three reports, one request each, all batched over the whole window with
 * `date` as a dimension so a row is one day. The alternative — a request per
 * day — is ninety round trips for data the API will return in one.
 *
 * **Sessions, landing pages and source/medium, and nothing that identifies a
 * person.** The Data API has no `clientId` or `sessionId` dimension, so there
 * is nothing here to join a session to a lead with even if somebody wanted to.
 */

const DEFAULT_BREAKDOWN_LIMIT = 250;

type ApiResponse = {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string }[];
  rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];
  rowCount?: number;
};

const METRICS = ['sessions', 'engagedSessions', 'totalUsers'] as const;

/** GA4 returns `YYYYMMDD`; everything downstream speaks `YYYY-MM-DD`. */
export function parseGa4Date(value: string): string | null {
  return /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : null;
}

function num(value: string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function normalizeGa4(
  response: ApiResponse,
  dimension: Ga4Row['dimension'],
): Ga4Row[] {
  const out: Ga4Row[] = [];
  for (const row of response.rows ?? []) {
    const date = parseGa4Date(row.dimensionValues[0]?.value ?? '');
    // The date is part of the upsert key; a row without one would overwrite
    // another day rather than add to its own.
    if (!date) continue;
    const [sessions, engagedSessions, users] = row.metricValues.map((m) => num(m.value));
    out.push({
      date,
      dimension,
      // GA4's placeholders — `(not set)`, `(direct) / (none)`,
      // `(data not available)` — are kept verbatim. They are facts about the
      // property's configuration, and replacing them with a tidier word would
      // hide a data-quality problem behind a presentation decision.
      dimensionValue: dimension === 'total' ? '' : (row.dimensionValues[1]?.value ?? ''),
      sessions: sessions ?? 0,
      engagedSessions: engagedSessions ?? 0,
      users: users ?? 0,
    });
  }
  return out;
}

export function ga4Client(client: GoogleOrganicClient, config: Ga4Config) {
  const property = `${GA4_API}/properties/${String(config.propertyId).replace(/^properties\//, '')}:runReport`;
  const limit = config.breakdownLimit ?? DEFAULT_BREAKDOWN_LIMIT;

  const run = async (
    dimensions: string[],
    dimension: Ga4Row['dimension'],
    range: DateRange,
    rowLimit: number,
  ): Promise<Ga4Row[]> => {
    try {
      const response = await client.post<ApiResponse>(property, {
        dateRanges: [{ startDate: range.start, endDate: range.end }],
        dimensions: dimensions.map((name) => ({ name })),
        metrics: METRICS.map((name) => ({ name })),
        limit: rowLimit,
        // Ordered by sessions so a per-day cap keeps the rows that matter
        // rather than an arbitrary slice.
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      });
      return normalizeGa4(response, dimension);
    } catch (error) {
      if (error instanceof GoogleOrganicApiError && error.scopeInsufficient) {
        throw new GoogleOrganicApiError(
          error.status,
          error.url,
          error.reason,
          `The refresh token does not carry ${GA4_SCOPE}. A token cannot gain a ` +
            'scope: re-run `pnpm --filter @zeeraa/connectors google-ads-token` and ' +
            'store the new token. This is not a Cloud project or property problem.',
        );
      }
      throw error;
    }
  };

  /**
   * GA4's own totals for a whole range, with no date breakdown: users counted
   * once across the range, as the GA4 interface counts them. The daily rows
   * cannot give this — a user who visits on three days is three daily users —
   * so the monthly figure is asked for, never summed.
   */
  const periodTotals = async (range: DateRange) => {
    const response = await client.post<ApiResponse>(property, {
      dateRanges: [{ startDate: range.start, endDate: range.end }],
      metrics: METRICS.map((name) => ({ name })),
    });
    const values = response.rows?.[0]?.metricValues.map((m) => num(m.value)) ?? [0, 0, 0];
    return { sessions: values[0] ?? 0, engagedSessions: values[1] ?? 0, users: values[2] ?? 0 };
  };

  return {
    /** The day's authoritative totals. */
    daily: (range: DateRange) => run(['date'], 'total', range, 100_000),
    periodTotals,
    /**
     * Landing pages, one row per page per day.
     *
     * `date` is the first dimension so every row carries its own day and any
     * window is re-computable from stored rows. The row cap applies across the
     * window, not per day — the API orders by sessions descending, so what a
     * cap drops is the long tail rather than a particular day.
     */
    landingPages: (range: DateRange) =>
      run(['date', 'landingPage'], 'landing_page', range, limit * 120),
    sourceMedium: (range: DateRange) =>
      run(['date', 'sessionSourceMedium'], 'source_medium', range, limit * 120),
  };
}
