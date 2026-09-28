import { withJobTenant, type Database } from '@zeeraa/db';
import { tenantDay, trailingWindow, type DateRange } from '@zeeraa/core';
import { closeSyncRun, openSyncRun, recordSyncedDays } from '../sync-runs';
import { buildAttribution, type JoinResult } from '../google-ads/join';
import { upsertCampaigns, upsertDailyMetrics } from '../google-ads/writer';
import type { LinkedInContext } from './context';

/**
 * The LinkedIn Ads sync: campaigns, then daily spend, impressions, clicks and
 * conversions per campaign, then the shared attribution join. The Meta sync,
 * step for step.
 *
 * Days are LinkedIn's UTC days (see `checkLinkedInReportingZone`), so every
 * run is `partial` with that stated — the same as a Meta account in another
 * zone. Every write is an upsert on (tenant, platform, campaign, date), so the
 * hourly two-day window and the nightly ninety-day re-pull converge rather
 * than double-count.
 */

export const DEFAULT_WINDOW_DAYS = 90;
/** Thirty days before the grant ends, the run says so, so Connect is pressed in time. */
export const RECONNECT_WARNING_DAYS = 30;

export type LinkedInSyncResult = {
  syncRunId: string;
  campaigns: number;
  dailyMetrics: number;
  join: JoinResult;
  accountWarning: string | null;
  status: 'succeeded' | 'partial' | 'failed';
};

export async function runLinkedInSync(
  context: LinkedInContext,
  options: { trigger?: string; now?: Date; windowDays?: number; range?: DateRange } = {},
): Promise<LinkedInSyncResult> {
  const now = options.now ?? new Date();
  const today = tenantDay(now, context.connection.tenantTimezone);
  const range: DateRange = options.range ?? trailingWindow(today, options.windowDays ?? DEFAULT_WINDOW_DAYS);
  const runInTenant = <T>(fn: (tx: Database) => Promise<T>) => withJobTenant(context.tenantId, fn);

  const syncRunId = await runInTenant((tx) =>
    openSyncRun(tx, context.tenantId, options.trigger ?? 'nightly', now, 'linkedin_ads'),
  );
  const result: LinkedInSyncResult = {
    syncRunId,
    campaigns: 0,
    dailyMetrics: 0,
    join: {
      opportunities: 0,
      attributionRows: 0,
      coverage: {
        first_touch: { total: 0, attributed: 0, noTouches: 0, clickWithoutCampaign: 0, rate: null },
        last_touch: { total: 0, attributed: 0, noTouches: 0, clickWithoutCampaign: 0, rate: null },
      },
    },
    accountWarning: null,
    status: 'succeeded',
  };
  const warn = (text: string) => {
    result.accountWarning = [result.accountWarning, text].filter(Boolean).join(' ');
    result.status = 'partial';
  };

  try {
    const health = await context.connector.testConnection(context.connection);
    if (health.state === 'degraded') warn(health.detail);
    if (health.state === 'waiting_on_client' || health.state === 'failing') {
      warn(health.detail);
      await runInTenant((tx) => closeSyncRun(tx, syncRunId, 'partial', 0, result.accountWarning));
      return result;
    }
    if (context.refreshTokenExpiresAt) {
      const daysLeft = Math.floor((new Date(context.refreshTokenExpiresAt).getTime() - now.getTime()) / 86_400_000);
      if (daysLeft <= RECONNECT_WARNING_DAYS) {
        warn(`The LinkedIn grant ends in ${Math.max(0, daysLeft)} days; press Connect on Connections before then.`);
      }
    }

    const campaigns = (await context.connector.fetchEntities?.(context.connection)) ?? [];
    const campaignIds = await runInTenant((tx) => upsertCampaigns(tx, context.tenantId, 'linkedin_ads', campaigns));
    result.campaigns = campaigns.length;

    const metrics = await context.connector.fetchDailyMetrics(context.connection, range);
    result.dailyMetrics = await runInTenant(async (tx) => {
      const written = await upsertDailyMetrics(tx, context.tenantId, 'linkedin_ads', metrics, campaignIds, syncRunId);
      // LinkedIn answers for today while it is still running; no delivery on
      // a day is a measurement, so every day asked about is recorded.
      await recordSyncedDays(tx, context.tenantId, 'linkedin_ads', range, { today, syncRunId });
      return written;
    });

    result.join = await runInTenant((tx) => buildAttribution(tx, context.tenantId));

    await runInTenant((tx) =>
      closeSyncRun(tx, syncRunId, result.status, result.campaigns + result.dailyMetrics + result.join.attributionRows, result.accountWarning),
    );
    return result;
  } catch (error) {
    await runInTenant((tx) => closeSyncRun(tx, syncRunId, 'failed', result.campaigns + result.dailyMetrics, String(error)));
    throw error;
  }
}
