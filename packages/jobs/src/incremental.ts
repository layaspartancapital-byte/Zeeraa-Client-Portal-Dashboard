import { withJobTenant } from '@zeeraa/db';
import { listGoogleAdsConnections, resolveGoogleAdsContext } from './google-ads/context';
import { runGoogleAdsSync } from './google-ads/sync';
import { listSalesforceConnections, resolveSalesforceContext } from './salesforce/context';
import { runSalesforceSync } from './salesforce/sync';
import { backfillClickIdsFromConvertedLeads } from './salesforce/backfill';
import { lastCompletedWatermark } from './sync-runs';

/**
 * The hourly incremental sync, sized for a 60-second serverless function.
 *
 * This is the routine path: Vercel Cron calls it on the hour and the
 * "Sync now" button calls the same function for one tenant. It is deliberately
 * *not* the backfill. Two things keep it inside the budget, and both of them
 * matter more than they look:
 *
 *   - **Paid media is pulled for a two-day window.** Google restates
 *     conversions for thirty days and more, so the nightly re-pulls ninety and
 *     upserts. Ninety days of `click_view` is ninety sequential requests and
 *     takes about a minute on its own. Two days is the smallest window that
 *     still absorbs a restatement of yesterday plus a missed run, and it
 *     upserts exactly as the long window does, so nothing double-counts.
 *
 *   - **Salesforce is asked what changed since it last finished reading**, and
 *     if that answer is missing or stale the platform is skipped rather than
 *     attempted. A first run, or a run after a long outage, is a full pull of
 *     tens of thousands of records; starting one here would hit the function
 *     timeout, leave a `running` row in the ledger and get retried on the hour
 *     forever. Skipping says so instead, and names the script to run.
 *
 * Nothing here throws. Every unit is caught and reported, because one tenant's
 * revoked credential must not stop another tenant's window from being
 * captured — and because the caller is an HTTP handler that has to answer.
 */

export type SyncPlatform = 'google_ads' | 'salesforce';

export type PlatformOutcome = {
  tenantId: string;
  platform: SyncPlatform;
  /**
   * `skipped` is a first-class outcome, not a soft failure: it is what the
   * endpoint reports when the honest incremental window does not exist.
   */
  status: 'succeeded' | 'partial' | 'skipped' | 'failed';
  detail: string;
  /** Present on `skipped` and `failed`, so the UI can name the next action. */
  remedy?: string;
  durationMs: number;
};

export type IncrementalResult = {
  startedAt: string;
  durationMs: number;
  /** False when any unit failed. A `skipped` unit does not make this false. */
  ok: boolean;
  outcomes: PlatformOutcome[];
};

export type IncrementalOptions = {
  /** One tenant, or every connected tenant when absent. */
  tenantId?: string;
  /** Narrow to one platform — the per-connection "Sync now" button. */
  platforms?: SyncPlatform[];
  trigger?: string;
  now?: Date;
  /** Trailing days of spend and `click_view` to re-pull. */
  spendWindowDays?: number;
  /**
   * How stale the Salesforce watermark may be before the platform is skipped.
   * Generous against the hourly cadence on purpose: several missed runs should
   * still be caught up incrementally rather than deferred to a human.
   */
  maxWatermarkAgeHours?: number;
  /**
   * Stop starting new units after this many milliseconds. Well inside the
   * function limit, because a unit already in flight still has to finish.
   */
  deadlineMs?: number;
};

const DEFAULTS = {
  spendWindowDays: 2,
  maxWatermarkAgeHours: 26,
  deadlineMs: 45_000,
} as const;

export async function runIncrementalSync(
  options: IncrementalOptions = {},
): Promise<IncrementalResult> {
  const startedAt = options.now ?? new Date();
  const began = Date.now();
  const trigger = options.trigger ?? 'incremental';
  const spendWindowDays = options.spendWindowDays ?? DEFAULTS.spendWindowDays;
  const maxAgeHours = options.maxWatermarkAgeHours ?? DEFAULTS.maxWatermarkAgeHours;
  const deadlineMs = options.deadlineMs ?? DEFAULTS.deadlineMs;
  const wanted = (platform: SyncPlatform) =>
    !options.platforms || options.platforms.includes(platform);
  const mine = (tenantId: string) => !options.tenantId || options.tenantId === tenantId;

  const outcomes: PlatformOutcome[] = [];
  const elapsed = () => Date.now() - began;

  const unit = async (
    tenantId: string,
    platform: SyncPlatform,
    work: () => Promise<Pick<PlatformOutcome, 'status' | 'detail'> & { remedy?: string }>,
  ) => {
    if (elapsed() > deadlineMs) {
      outcomes.push({
        tenantId,
        platform,
        status: 'skipped',
        detail: `Not started: ${Math.round(elapsed() / 1000)}s of the budget was already spent.`,
        remedy: 'The next hourly run picks it up; nothing is lost.',
        durationMs: 0,
      });
      return;
    }
    const unitBegan = Date.now();
    try {
      const done = await work();
      outcomes.push({ tenantId, platform, ...done, durationMs: Date.now() - unitBegan });
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

  // Ads first: `click_view` is the only thing here with an expiry on it, so it
  // runs before anything that could consume the budget.
  if (wanted('google_ads')) {
    for (const connection of await listGoogleAdsConnections()) {
      if (!mine(connection.tenantId)) continue;
      await unit(connection.tenantId, 'google_ads', async () => {
        const context = await resolveGoogleAdsContext(
          connection.tenantId,
          connection.connectionId,
        );
        const result = await runGoogleAdsSync(context, {
          trigger,
          now: startedAt,
          windowDays: spendWindowDays,
          maxClickDays: spendWindowDays,
        });
        const clicks = result.clicks;
        const detail =
          `${result.campaigns} campaigns, ${result.dailyMetrics} metric rows, ` +
          `${clicks.daysSucceeded}/${clicks.daysAttempted} click days, ` +
          `${clicks.clicksWritten} clicks`;
        // Days that aged out are unrecoverable, so they are named rather than
        // folded into a count. Not a failure — no retry fixes it — but the one
        // thing in this result somebody has to act on.
        const expired =
          clicks.daysExpired > 0
            ? ` — ${clicks.daysExpired} click ${
                clicks.daysExpired === 1 ? 'day' : 'days'
              } aged out of the 90-day window uningested and cannot be recovered`
            : '';
        return {
          status: result.status === 'failed' ? 'failed' : result.status,
          detail: detail + expired,
          remedy: clicks.daysRemaining > 0
            ? `${clicks.daysRemaining} click days still outstanding — run backfill-clicks.`
            : undefined,
        };
      });
    }
  }

  if (wanted('salesforce')) {
    for (const connection of await listSalesforceConnections()) {
      if (!mine(connection.tenantId)) continue;
      await unit(connection.tenantId, 'salesforce', async () => {
        const since = await withJobTenant(connection.tenantId, (tx) =>
          lastCompletedWatermark(tx, connection.tenantId),
        );

        if (!since) {
          return {
            status: 'skipped' as const,
            detail:
              'No previous run to read a change window from, so the only honest ' +
              'incremental window is "everything".',
            remedy:
              'Run `pnpm --filter @zeeraa/jobs sync-salesforce <slug>` once; ' +
              'the hourly run takes over from there.',
          };
        }

        const ageHours = (startedAt.getTime() - since.getTime()) / 3_600_000;
        if (ageHours > maxAgeHours) {
          return {
            status: 'skipped' as const,
            detail:
              `Last completed read was ${Math.round(ageHours)}h ago, beyond the ` +
              `${maxAgeHours}h this endpoint will attempt in one function.`,
            remedy:
              'Run `pnpm --filter @zeeraa/jobs sync-salesforce <slug>` to close the ' +
              'gap; the hourly run resumes afterwards.',
          };
        }

        const context = await resolveSalesforceContext(
          connection.tenantId,
          connection.connectionId,
        );
        const sync = await runSalesforceSync(context, { trigger, now: startedAt, since });
        // Bounded by the same window, so it cannot walk every converted lead
        // in the org on an hourly schedule.
        const backfill = await backfillClickIdsFromConvertedLeads({
          tenantId: context.tenantId,
          client: context.client,
          mapping: context.mapping,
          since,
        });
        return {
          status: sync.status === 'failed' ? ('failed' as const) : sync.status,
          detail:
            `since ${since.toISOString().slice(0, 16).replace('T', ' ')}Z — ` +
            `${sync.leads} leads, ${sync.opportunities} opportunities, ` +
            `${sync.stageEvents} stage events, ` +
            `${backfill.clickIdsRecovered} click ids recovered`,
          remedy:
            sync.missingFields.length > 0
              ? `Mapped fields absent from the org: ${sync.missingFields.join(', ')}.`
              : undefined,
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
