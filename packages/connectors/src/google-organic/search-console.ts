import type { DateRange } from '@zeeraa/core';
import { GoogleOrganicApiError, GoogleOrganicClient } from './client';
import {
  SEARCH_CONSOLE_API,
  SEARCH_CONSOLE_SCOPE,
  type SearchConsoleConfig,
  type SearchConsoleRow,
} from './types';

/**
 * Search Console, through the Search Analytics API.
 *
 * Channel-level by construction: it reports what a query did and what a page
 * did, and never who. There is nothing here that could reach the attribution
 * join even in principle.
 *
 * Two things about this API shape the code:
 *
 *   - **It finalises late.** Figures for the last two to three days move after
 *     the fact, which is why the nightly re-pulls the whole window and upserts.
 *   - **It withholds rows to protect privacy.** Queries issued by very few
 *     people are omitted entirely, so the query breakdown never sums to the
 *     day's total clicks. That is the API behaving correctly and the page
 *     states the coverage rather than implying the visible rows are all of it.
 */

const DEFAULT_BREAKDOWN_LIMIT = 250;
/** The API's own ceiling for one request. */
const MAX_ROWS = 25_000;

type ApiRow = {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
};

export function normalizeSearchConsole(
  rows: readonly ApiRow[] | undefined,
  dimension: SearchConsoleRow['dimension'],
): SearchConsoleRow[] {
  const out: SearchConsoleRow[] = [];
  for (const row of rows ?? []) {
    const date = row.keys?.[0];
    // `YYYY-MM-DD` already, but the date is the upsert key so a malformed one
    // is dropped rather than defaulted onto another day.
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push({
      date,
      dimension,
      dimensionValue: dimension === 'total' ? '' : (row.keys?.[1] ?? ''),
      clicks: Number(row.clicks ?? 0),
      impressions: Number(row.impressions ?? 0),
      // `ctr` is deliberately discarded: it is clicks over impressions and is
      // derived at read time, so no stored ratio can be destroyed by a sum.
      position: row.position === undefined ? null : Number(row.position),
    });
  }
  return out;
}

export function searchConsoleClient(
  client: GoogleOrganicClient,
  config: SearchConsoleConfig,
) {
  // The site URL is a path segment and routinely contains `:` and `/`, so it
  // has to be fully encoded — `sc-domain:example.com` breaks the route
  // otherwise, and the resulting 404 reads like the property does not exist.
  const endpoint = `${SEARCH_CONSOLE_API}/sites/${encodeURIComponent(config.siteUrl)}/searchAnalytics/query`;
  const limit = config.breakdownLimit ?? DEFAULT_BREAKDOWN_LIMIT;

  const run = async (
    dimensions: string[],
    dimension: SearchConsoleRow['dimension'],
    range: DateRange,
    rowLimit: number,
  ): Promise<SearchConsoleRow[]> => {
    try {
      const response = await client.post<{ rows?: ApiRow[] }>(endpoint, {
        startDate: range.start,
        endDate: range.end,
        dimensions,
        rowLimit: Math.min(rowLimit, MAX_ROWS),
        // Web results only. Image and video search answer a different question
        // and mixing them into one position figure would average two rankings
        // that were never competing for the same slot.
        type: 'web',
      });
      return normalizeSearchConsole(response.rows, dimension);
    } catch (error) {
      if (error instanceof GoogleOrganicApiError && error.scopeInsufficient) {
        throw new GoogleOrganicApiError(
          error.status,
          error.url,
          error.reason,
          `The refresh token does not carry ${SEARCH_CONSOLE_SCOPE}. A token cannot ` +
            'gain a scope: re-run `pnpm --filter @zeeraa/connectors google-ads-token` ' +
            'and store the new token.',
        );
      }
      throw error;
    }
  };

  return {
    daily: (range: DateRange) => run(['date'], 'total', range, MAX_ROWS),
    queries: (range: DateRange) => run(['date', 'query'], 'query', range, limit * 120),
    pages: (range: DateRange) => run(['date', 'page'], 'page', range, limit * 120),
    /** Which properties this token can actually see, for the connection test. */
    sites: () => client.get<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(
      `${SEARCH_CONSOLE_API}/sites`,
    ),
  };
}
