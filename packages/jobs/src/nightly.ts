import { withJobTenant } from '@zeeraa/db';
import { tenantDay, trailingWindow } from '@zeeraa/core';
import { listGoogleAdsConnections, resolveGoogleAdsContext } from './google-ads/context';
import { runGoogleAdsSync } from './google-ads/sync';
import { listMetaConnections, resolveMetaContext } from './meta/context';
import { runMetaSync } from './meta/sync';
import { listOrganicConnections, resolveOrganicContext } from './google-organic/context';
import { runGa4Sync, runSearchConsoleSync } from './google-organic/sync';
import { recordSkippedRun } from './sync-runs';
import type { IncrementalResult, PlatformOutcome, SyncPlatform } from './incremental';

/**
 * The nightly re-pull: the long window the hourly run is too small for.
 *
 * Platforms restate. Google moves conversions for thirty days and more after
 * the click, Meta adjusts spend by cents for days, and GA4 keeps processing a
 * finished day. The brief always called for a nightly job re-reading a trailing
 * ninety days and upserting over it; until 23 September 2026 no such job was
 * scheduled, so a restatement older than two days never landed — September's
 * Google Ads conversions were four short of the API's.
 *
 * Spend only, one request per platform whatever the range, so ninety days fits
 * a function: `click_view` is the incremental run's, where its per-day cost is
 * budgeted. Every write is an upsert on (tenant, platform, campaign, date), so
 * re-reading a day replaces it and nothing double-counts.
 */
export type NightlyOptions = {
  tenantId?: string;
  trigger?: string;
  now?: Date;
  /** Days of paid media to re-read. Ninety is what the platforms restate over. */
  adsDays?: number;
  /** Days of GA4 and Search Console. They settle faster and carry breakdowns. */
  organicDays?: number;
  deadlineMs?: number;
};

const DEFAULTS = { adsDays: 90, organicDays: 35, deadlineMs: 240_000 } as const;

export async function runNightlyRepull(options: NightlyOptions = {}): Promise<IncrementalResult> {
  const startedAt = options.now ?? new Date();
  const began = Date.now();
  const trigger = options.trigger ?? 'nightly';
  const adsDays = options.adsDays ?? DEFAULTS.adsDays;
  const organicDays = options.organicDays ?? DEFAULTS.organicDays;
  const deadlineMs = options.deadlineMs ?? DEFAULTS.deadlineMs;
  const mine = (tenantId: string) => !options.tenantId || options.tenantId === tenantId;
  const outcomes: PlatformOutcome[] = [];
  const elapsed = () => Date.now() - began;

  const unit = async (
    tenantId: string,
    platform: SyncPlatform,
    work: () => Promise<Pick<PlatformOutcome, 'status' | 'detail'>>,
  ) => {
    if (elapsed() > deadlineMs) {
      const detail = `Not started: ${Math.round(elapsed() / 1000)}s of the budget was already spent.`;
      outcomes.push({ tenantId, platform, status: 'skipped', detail, durationMs: 0 });
      await withJobTenant(tenantId, (tx) =>
        recordSkippedRun(tx, tenantId, platform, trigger, startedAt, detail),
      ).catch(() => undefined);
      return;
    }
    const unitBegan = Date.now();
    try {
      outcomes.push({ tenantId, platform, ...(await work()), durationMs: Date.now() - unitBegan });
    } catch (error) {
      outcomes.push({
        tenantId,
        platform,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - unitBegan,
      });
    }
  };

  for (const connection of await listGoogleAdsConnections()) {
    if (!mine(connection.tenantId)) continue;
    await unit(connection.tenantId, 'google_ads', async () => {
      const context = await resolveGoogleAdsContext(connection.tenantId, connection.connectionId);
      const range = trailingWindow(tenantDay(startedAt, context.connection.tenantTimezone), adsDays);
      const result = await runGoogleAdsSync(context, { trigger, now: startedAt, range, maxClickDays: 0 });
      return {
        status: result.status === 'failed' ? 'failed' : result.status,
        detail: `${range.start} → ${range.end}: ${result.dailyMetrics} metric rows re-read`,
      };
    });
  }

  for (const connection of await listMetaConnections()) {
    if (!mine(connection.tenantId)) continue;
    await unit(connection.tenantId, 'meta', async () => {
      const context = await resolveMetaContext(connection.tenantId, connection.connectionId);
      const range = trailingWindow(tenantDay(startedAt, context.connection.tenantTimezone), adsDays);
      const result = await runMetaSync(context, { trigger, now: startedAt, range });
      return {
        status: result.status === 'failed' ? 'failed' : result.status,
        detail: `${range.start} → ${range.end}: ${result.dailyMetrics} metric rows re-read`,
      };
    });
  }

  for (const platform of ['ga4', 'search_console'] as const) {
    for (const connection of await listOrganicConnections(platform)) {
      if (!mine(connection.tenantId)) continue;
      await unit(connection.tenantId, platform, async () => {
        const context = await resolveOrganicContext(connection.tenantId, connection.connectionId, platform);
        const range = trailingWindow(tenantDay(startedAt, context.tenantTimezone), organicDays);
        const result =
          platform === 'ga4'
            ? await runGa4Sync(context, { trigger, now: startedAt, range })
            : await runSearchConsoleSync(context, { trigger, now: startedAt, range });
        return {
          status: result.status === 'failed' ? 'failed' : result.status,
          detail: `${result.range.start} → ${result.range.end}: ${result.totals} daily rows re-read`,
        };
      });
    }
  }

  return {
    startedAt: startedAt.toISOString(),
    durationMs: elapsed(),
    ok: !outcomes.some((o) => o.status === 'failed'),
    outcomes,
  };
}
