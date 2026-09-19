import { withJobTenant, type Database } from '@zeeraa/db';
import { tenantDay, trailingWindow, type DateRange } from '@zeeraa/core';
import { ga4Client, searchConsoleClient } from '@zeeraa/connectors';
import { closeSyncRun, openSyncRun } from '../sync-runs';
import { upsertGa4Metrics, upsertSearchConsoleMetrics } from './writer';
import type { OrganicContext } from './context';

/**
 * The GA4 and Search Console syncs.
 *
 * Three requests each — a daily total and two breakdowns — over the whole
 * window, because both APIs take a date range and return a row per day. There
 * is no click pass, no entity pass and **no attribution pass**: neither source
 * can name a person, so neither has anything to join.
 *
 * The window is re-pulled and upserted rather than appended from a watermark,
 * because both restate: GA4 reprocesses for about 48 hours and Search Console
 * finalises over two to three days.
 */

export const DEFAULT_WINDOW_DAYS = 90;
/**
 * Search Console has no data for the last two days and partial data for the
 * third. Asking for them is not an error — it returns nothing, which then looks
 * like a collapse in traffic on a chart.
 */
export const SEARCH_CONSOLE_LAG_DAYS = 3;

export type OrganicSyncResult = {
  syncRunId: string;
  /** Rows per dimension, so a breakdown that came back empty is visible. */
  totals: number;
  breakdownA: number;
  breakdownB: number;
  range: DateRange;
  status: 'succeeded' | 'partial' | 'failed';
  note: string | null;
};

export async function runGa4Sync(
  context: OrganicContext,
  options: { trigger?: string; now?: Date; windowDays?: number } = {},
): Promise<OrganicSyncResult> {
  const now = options.now ?? new Date();
  const today = tenantDay(now, context.tenantTimezone);
  const range = trailingWindow(today, options.windowDays ?? DEFAULT_WINDOW_DAYS);
  const runInTenant = <T>(fn: (tx: Database) => Promise<T>) => withJobTenant(context.tenantId, fn);

  const syncRunId = await runInTenant((tx) =>
    openSyncRun(tx, context.tenantId, options.trigger ?? 'nightly', now, 'ga4'),
  );
  const result: OrganicSyncResult = {
    syncRunId, totals: 0, breakdownA: 0, breakdownB: 0, range, status: 'succeeded', note: null,
  };

  try {
    if (!context.config.propertyId) {
      result.status = 'partial';
      result.note = 'No GA4 property id is configured for this client.';
      await runInTenant((tx) => closeSyncRun(tx, syncRunId, 'partial', 0, result.note));
      return result;
    }

    const ga4 = ga4Client(context.client, context.config);
    const [daily, landingPages, sourceMedium] = await Promise.all([
      ga4.daily(range),
      ga4.landingPages(range),
      ga4.sourceMedium(range),
    ]);

    result.totals = await runInTenant((tx) => upsertGa4Metrics(tx, context.tenantId, daily, syncRunId));
    result.breakdownA = await runInTenant((tx) =>
      upsertGa4Metrics(tx, context.tenantId, landingPages, syncRunId),
    );
    result.breakdownB = await runInTenant((tx) =>
      upsertGa4Metrics(tx, context.tenantId, sourceMedium, syncRunId),
    );

    await runInTenant((tx) => closeSyncRun(tx, syncRunId, 'succeeded', total(result), null));
    return result;
  } catch (error) {
    await runInTenant((tx) => closeSyncRun(tx, syncRunId, 'failed', total(result), String(error)));
    throw error;
  }
}

export async function runSearchConsoleSync(
  context: OrganicContext,
  options: { trigger?: string; now?: Date; windowDays?: number } = {},
): Promise<OrganicSyncResult> {
  const now = options.now ?? new Date();
  const today = tenantDay(now, context.tenantTimezone);
  const full = trailingWindow(today, options.windowDays ?? DEFAULT_WINDOW_DAYS);
  // Ends where Search Console actually has data. Asking past that returns
  // nothing, which draws as a cliff rather than as an absence.
  const range: DateRange = {
    start: full.start,
    end: shiftDays(full.end, -SEARCH_CONSOLE_LAG_DAYS),
  };
  const runInTenant = <T>(fn: (tx: Database) => Promise<T>) => withJobTenant(context.tenantId, fn);

  const syncRunId = await runInTenant((tx) =>
    openSyncRun(tx, context.tenantId, options.trigger ?? 'nightly', now, 'search_console'),
  );
  const result: OrganicSyncResult = {
    syncRunId, totals: 0, breakdownA: 0, breakdownB: 0, range, status: 'succeeded',
    note: `Ends ${SEARCH_CONSOLE_LAG_DAYS} days short of today: Search Console has not finalised more recent days.`,
  };

  try {
    if (!context.config.siteUrl) {
      result.status = 'partial';
      result.note = 'No Search Console site URL is configured for this client.';
      await runInTenant((tx) => closeSyncRun(tx, syncRunId, 'partial', 0, result.note));
      return result;
    }

    const gsc = searchConsoleClient(context.client, context.config);
    const [daily, queries, pages] = await Promise.all([
      gsc.daily(range),
      gsc.queries(range),
      gsc.pages(range),
    ]);

    result.totals = await runInTenant((tx) =>
      upsertSearchConsoleMetrics(tx, context.tenantId, daily, syncRunId),
    );
    result.breakdownA = await runInTenant((tx) =>
      upsertSearchConsoleMetrics(tx, context.tenantId, queries, syncRunId),
    );
    result.breakdownB = await runInTenant((tx) =>
      upsertSearchConsoleMetrics(tx, context.tenantId, pages, syncRunId),
    );

    await runInTenant((tx) => closeSyncRun(tx, syncRunId, 'succeeded', total(result), null));
    return result;
  } catch (error) {
    await runInTenant((tx) => closeSyncRun(tx, syncRunId, 'failed', total(result), String(error)));
    throw error;
  }
}

function total(r: OrganicSyncResult): number {
  return r.totals + r.breakdownA + r.breakdownB;
}

function shiftDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
