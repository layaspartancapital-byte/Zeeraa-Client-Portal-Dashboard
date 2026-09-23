import { withJobTenant, type Database } from '@zeeraa/db';
import { tenantDay, trailingWindow, type DateRange } from '@zeeraa/core';
import { checkReportingZone, normalizeAccount, accountQuery } from '@zeeraa/connectors';
import { closeSyncRun, openSyncRun, recordSyncedDays } from '../sync-runs';
import { buildAttribution, type JoinResult } from './join';
import { ingestClicks, type ClickIngestResult } from './clicks';
import { upsertCampaigns, upsertDailyMetrics } from './writer';
import type { GoogleAdsContext } from './context';

/**
 * The nightly Google Ads sync.
 *
 * Three passes, in order, because each depends on the last:
 *
 *   1. Campaigns, so spend and clicks have something to hang off.
 *   2. Daily spend for the trailing window, batched in one request (§6, §7).
 *   3. Clicks, one day at a time, resumable — the exception to (2), and the
 *      only part with an expiry on it.
 *
 * Then the join, which is local: it reads what the first three wrote and needs
 * no further API calls.
 */

export const DEFAULT_WINDOW_DAYS = 90;

export type GoogleAdsSyncResult = {
  syncRunId: string;
  campaigns: number;
  dailyMetrics: number;
  clicks: ClickIngestResult;
  join: JoinResult;
  /** Non-null when the ad account's day boundaries differ from the tenant's. */
  reportingZoneWarning: string | null;
  status: 'succeeded' | 'partial' | 'failed';
};

export async function runGoogleAdsSync(
  context: GoogleAdsContext,
  options: {
    trigger?: string;
    now?: Date;
    windowDays?: number;
    /** An explicit range, overriding `windowDays` — how a missed day is caught up. */
    range?: DateRange;
    maxClickDays?: number;
    /**
     * Skip the spend pull and do only clicks and the join. The runner pulls
     * every platform's spend first and Google's day-by-day `click_view` last,
     * so a slow click backlog cannot starve Meta or Salesforce of the budget.
     */
    clicksOnly?: boolean;
  } = {},
): Promise<GoogleAdsSyncResult> {
  const now = options.now ?? new Date();
  const today = tenantDay(now, context.connection.tenantTimezone);
  const range: DateRange =
    options.range ?? trailingWindow(today, options.windowDays ?? DEFAULT_WINDOW_DAYS);

  const runInTenant = <T>(fn: (tx: Database) => Promise<T>) => withJobTenant(context.tenantId, fn);

  const syncRunId = await runInTenant((tx) =>
    openSyncRun(tx, context.tenantId, options.trigger ?? 'nightly', now, 'google_ads'),
  );

  const result: GoogleAdsSyncResult = {
    syncRunId,
    campaigns: 0,
    dailyMetrics: 0,
    clicks: {
      daysAttempted: 0,
      daysSucceeded: 0,
      daysFailed: 0,
      daysExpired: 0,
      daysRemaining: 0,
      clicksWritten: 0,
    },
    join: {
      opportunities: 0,
      attributionRows: 0,
      coverage: {
        first_touch: { total: 0, attributed: 0, noTouches: 0, clickWithoutCampaign: 0, rate: null },
        last_touch: { total: 0, attributed: 0, noTouches: 0, clickWithoutCampaign: 0, rate: null },
      },
    },
    reportingZoneWarning: null,
    status: 'succeeded',
  };

  try {
    // The zone check runs first and does not stop the sync. A misaligned account
    // still produces usable data; it produces data whose day boundaries are off
    // by up to a day, which is a thing to say once rather than a reason to
    // refuse the whole pull.
    const health = await context.connector.testConnection(context.connection);
    if (health.state === 'degraded') {
      result.reportingZoneWarning = health.detail;
      result.status = 'partial';
    }

    if (!options.clicksOnly) {
      const campaigns = (await context.connector.fetchEntities?.(context.connection)) ?? [];
      const campaignIds = await runInTenant((tx) =>
        upsertCampaigns(tx, context.tenantId, 'google_ads', campaigns),
      );
      result.campaigns = campaigns.length;

      const metrics = await context.connector.fetchDailyMetrics(context.connection, range);
      result.dailyMetrics = await runInTenant(async (tx) => {
        const written = await upsertDailyMetrics(
          tx, context.tenantId, 'google_ads', metrics, campaignIds, syncRunId,
        );
        // Every day of the range was asked for and answered, including the
        // ones with no spend, so every day is recorded as read.
        await recordSyncedDays(tx, context.tenantId, 'google_ads', range, { today, syncRunId });
        return written;
      });
    }

    result.clicks = await ingestClicks(
      runInTenant,
      {
        tenantId: context.tenantId,
        platform: 'google_ads',
        connection: context.connection,
        connector: context.connector,
        syncRunId,
        today,
        maxDays: options.maxClickDays,
      },
      range,
    );
    // A spend-only pass (`maxClickDays: 0`) leaves the click backlog to the
    // click pass by design; outstanding days are not this pass falling short.
    if (
      result.clicks.daysFailed > 0 ||
      (options.maxClickDays !== 0 && result.clicks.daysRemaining > 0)
    ) {
      result.status = 'partial';
    }

    result.join = await runInTenant((tx) => buildAttribution(tx, context.tenantId));

    await runInTenant((tx) =>
      closeSyncRun(tx, syncRunId, result.status, totalRows(result), result.clicks.firstError ?? null),
    );
    return result;
  } catch (error) {
    await runInTenant((tx) =>
      closeSyncRun(tx, syncRunId, 'failed', totalRows(result), String(error)),
    );
    throw error;
  }
}

function totalRows(result: GoogleAdsSyncResult): number {
  return (
    result.campaigns + result.dailyMetrics + result.clicks.clicksWritten + result.join.attributionRows
  );
}

export { accountQuery, checkReportingZone, normalizeAccount };
