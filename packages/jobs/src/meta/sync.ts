import { withJobTenant, type Database } from '@zeeraa/db';
import { tenantDay, trailingWindow, type DateRange } from '@zeeraa/core';
import { closeSyncRun, openSyncRun } from '../sync-runs';
import { buildAttribution, type JoinResult } from '../google-ads/join';
import { upsertCampaigns, upsertDailyMetrics } from '../google-ads/writer';
import type { MetaContext } from './context';

/**
 * The Meta sync.
 *
 * Two passes rather than Google's three, and the missing one is the point:
 * there is no click pass, because Meta publishes no endpoint that resolves an
 * `fbclid` to a campaign. Meta spend is known per campaign per day; Meta deals
 * are known by channel and never by campaign. That asymmetry is permanent and
 * is carried honestly rather than papered over — `ad_clicks` simply never holds
 * a Meta row, and every Meta deal reports as "click without campaign", which is
 * a state the model already had for Google clicks that aged out of the 90-day
 * window.
 *
 * The attribution pass is shared with Google Ads and unchanged. It reads
 * `opportunity_click_ids` and `leads.click_id` for every platform at once, so a
 * Meta touch resolves the moment the Salesforce mapping names `acq_fbclid__c`
 * — nothing here writes attribution rows itself.
 */

export const DEFAULT_WINDOW_DAYS = 90;

export type MetaSyncResult = {
  syncRunId: string;
  campaigns: number;
  dailyMetrics: number;
  join: JoinResult;
  /** Non-null when the ad account's day boundaries or currency differ. */
  accountWarning: string | null;
  status: 'succeeded' | 'partial' | 'failed';
};

export async function runMetaSync(
  context: MetaContext,
  options: { trigger?: string; now?: Date; windowDays?: number } = {},
): Promise<MetaSyncResult> {
  const now = options.now ?? new Date();
  const today = tenantDay(now, context.connection.tenantTimezone);
  const range: DateRange = trailingWindow(today, options.windowDays ?? DEFAULT_WINDOW_DAYS);

  const runInTenant = <T>(fn: (tx: Database) => Promise<T>) => withJobTenant(context.tenantId, fn);

  const syncRunId = await runInTenant((tx) =>
    openSyncRun(tx, context.tenantId, options.trigger ?? 'nightly', now, 'meta'),
  );

  const result: MetaSyncResult = {
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

  try {
    // Does not stop the sync. A misaligned zone or a mismatched currency still
    // produces usable data; it produces data with a stated defect, which is a
    // thing to say once rather than a reason to refuse the pull.
    const health = await context.connector.testConnection(context.connection);
    if (health.state === 'degraded') {
      result.accountWarning = health.detail;
      result.status = 'partial';
    }
    if (health.state === 'waiting_on_client') {
      // A disabled account or a revoked token. There is nothing to pull and
      // nothing a retry fixes, so this ends here rather than failing loudly on
      // the next call and burying the reason in a stack trace.
      result.accountWarning = health.detail;
      result.status = 'partial';
      await runInTenant((tx) => closeSyncRun(tx, syncRunId, 'partial', 0, health.detail));
      return result;
    }

    const campaigns = (await context.connector.fetchEntities?.(context.connection)) ?? [];
    const campaignIds = await runInTenant((tx) =>
      upsertCampaigns(tx, context.tenantId, 'meta', campaigns),
    );
    result.campaigns = campaigns.length;

    const metrics = await context.connector.fetchDailyMetrics(context.connection, range);
    result.dailyMetrics = await runInTenant((tx) =>
      upsertDailyMetrics(tx, context.tenantId, 'meta', metrics, campaignIds, syncRunId),
    );

    result.join = await runInTenant((tx) => buildAttribution(tx, context.tenantId));

    await runInTenant((tx) =>
      closeSyncRun(tx, syncRunId, result.status, totalRows(result), result.accountWarning),
    );
    return result;
  } catch (error) {
    await runInTenant((tx) =>
      closeSyncRun(tx, syncRunId, 'failed', totalRows(result), String(error)),
    );
    throw error;
  }
}

function totalRows(result: MetaSyncResult): number {
  return result.campaigns + result.dailyMetrics + result.join.attributionRows;
}
