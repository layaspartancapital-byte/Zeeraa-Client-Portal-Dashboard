import { withJobTenant } from '@zeeraa/db';
import { addDays, tenantDay, type DateRange } from '@zeeraa/core';
import { listGoogleAdsConnections, resolveGoogleAdsContext } from './google-ads/context';
import { runGoogleAdsSync } from './google-ads/sync';
import { listMetaConnections, resolveMetaContext } from './meta/context';
import { runMetaSync } from './meta/sync';
import { listOrganicConnections, resolveOrganicContext } from './google-organic/context';
import { runGa4Sync, runSearchConsoleSync } from './google-organic/sync';
import { listSalesforceConnections, resolveSalesforceContext } from './salesforce/context';
import { runSalesforceSync } from './salesforce/sync';
import { backfillClickIdsFromConvertedLeads } from './salesforce/backfill';
import { lastCompletedWatermark, recordSkippedRun, resumeWindow } from './sync-runs';

/**
 * The hourly incremental sync, sized for a 60-second serverless function.
 *
 * This is the routine path: Vercel Cron calls it on the hour and the
 * "Sync now" button calls the same function for one tenant. It is deliberately
 * *not* the backfill. Two things keep it inside the budget, and both of them
 * matter more than they look:
 *
 *   - **Each source resumes from the oldest day it has not read final**, up
 *     to `catchUpDays` back, with two days as the floor. The window used to be
 *     a fixed two days, which meant three days without a run left a hole
 *     nothing ever went back for — Meta and GA4 lost 19–20 September 2026
 *     exactly that way. Spend is one request whatever the range, so catching
 *     up costs nothing; restatements older than the catch-up are the nightly
 *     re-pull's (`nightly.ts`), which re-reads ninety days.
 *
 *   - **Cheap work first.** Every platform's spend, then Salesforce, then
 *     Google's `click_view`, which is one request *per day*. A click backlog
 *     used to run first and could spend the whole budget before Meta was
 *     reached; a skipped platform now also leaves a `skipped` row rather than
 *     nothing.
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

export type SyncPlatform = 'google_ads' | 'meta' | 'ga4' | 'search_console' | 'salesforce';

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
  /** Trailing days of spend and `click_view` to re-pull at minimum. */
  spendWindowDays?: number;
  /** How far back a source resumes from its oldest unread day. */
  catchUpDays?: number;
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
  catchUpDays: 35,
  // A week, not a day. The cadence this was sized for never materialised, and
  // at 26 hours a runner that fires once a day skipped Salesforce every time.
  // A few days of changes is a small read; a full pull is still refused.
  maxWatermarkAgeHours: 168,
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
  const catchUpDays = options.catchUpDays ?? DEFAULTS.catchUpDays;
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
      const detail = `Not started: ${Math.round(elapsed() / 1000)}s of the budget was already spent.`;
      outcomes.push({
        tenantId,
        platform,
        status: 'skipped',
        detail,
        remedy: 'The next run resumes from the oldest day this platform has not read.',
        durationMs: 0,
      });
      // Best-effort: a ledger row that cannot be written must not turn a
      // skip into a failure of the whole run.
      await withJobTenant(tenantId, (tx) =>
        recordSkippedRun(tx, tenantId, platform, trigger, startedAt, detail),
      ).catch(() => undefined);
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

  /** The range a platform's pull covers this run: resume, floor, catch-up cap. */
  const windowFor = (
    tenantId: string,
    platform: string,
    timezone: string,
    floorDays: number,
    lastDayOffset = 0,
  ): Promise<DateRange> => {
    const today = tenantDay(startedAt, timezone);
    return withJobTenant(tenantId, (tx) =>
      resumeWindow(tx, tenantId, platform, {
        today,
        floorDays,
        maxDays: catchUpDays,
        lastDay: lastDayOffset ? addDays(today, -lastDayOffset) : undefined,
      }),
    );
  };

  // Spend first, for every platform: one request each, whatever the range.
  if (wanted('google_ads')) {
    for (const connection of await listGoogleAdsConnections()) {
      if (!mine(connection.tenantId)) continue;
      await unit(connection.tenantId, 'google_ads', async () => {
        const context = await resolveGoogleAdsContext(
          connection.tenantId,
          connection.connectionId,
        );
        const range = await windowFor(
          connection.tenantId,
          'google_ads',
          context.connection.tenantTimezone,
          spendWindowDays,
        );
        const result = await runGoogleAdsSync(context, {
          trigger,
          now: startedAt,
          range,
          // Clicks come last, below, so a click backlog cannot starve the
          // other platforms' spend.
          maxClickDays: 0,
        });
        return {
          status: result.status === 'failed' ? 'failed' : result.status,
          detail: `${range.start} → ${range.end}: ${result.campaigns} campaigns, ${result.dailyMetrics} metric rows`,
        };
      });
    }
  }

  // Meta second. It has no click ledger and therefore nothing with an expiry,
  // so it yields the front of the budget to Google Ads — but it still runs
  // before Salesforce, because spend is two requests and a CRM read is not.
  if (wanted('meta')) {
    for (const connection of await listMetaConnections()) {
      if (!mine(connection.tenantId)) continue;
      await unit(connection.tenantId, 'meta', async () => {
        const context = await resolveMetaContext(connection.tenantId, connection.connectionId);
        const range = await windowFor(
          connection.tenantId,
          'meta',
          context.connection.tenantTimezone,
          spendWindowDays,
        );
        const result = await runMetaSync(context, { trigger, now: startedAt, range });
        return {
          status: result.status === 'failed' ? ('failed' as const) : result.status,
          detail:
            `${range.start} → ${range.end}: ${result.campaigns} campaigns, ${result.dailyMetrics} metric rows` +
            (result.accountWarning ? ` — ${result.accountWarning}` : ''),
          // Meta deals are attributable by channel and never by campaign, so
          // there is no click backfill to name here and no remedy to offer: a
          // missing campaign on a Meta deal is the platform, not an outstanding
          // job.
          remedy: undefined,
        };
      });
    }
  }

  // Then the organic sources. Three requests each and nothing that expires, so
  // they sit behind the two platforms whose windows have an edge.
  for (const platform of ['ga4', 'search_console'] as const) {
    if (!wanted(platform)) continue;
    for (const connection of await listOrganicConnections(platform)) {
      if (!mine(connection.tenantId)) continue;
      await unit(connection.tenantId, platform, async () => {
        const context = await resolveOrganicContext(
          connection.tenantId,
          connection.connectionId,
          platform,
        );
        // Search Console has not finalised the last few days, so its window
        // ends at the lag and its floor is wider than the lag: narrower would
        // ask for nothing at all and report a healthy zero.
        const range =
          platform === 'ga4'
            ? await windowFor(connection.tenantId, 'ga4', context.tenantTimezone, spendWindowDays)
            : await windowFor(connection.tenantId, 'search_console', context.tenantTimezone, 7, 3);
        const result =
          platform === 'ga4'
            ? await runGa4Sync(context, { trigger, now: startedAt, range })
            : await runSearchConsoleSync(context, { trigger, now: startedAt, range });
        return {
          status: result.status === 'failed' ? ('failed' as const) : result.status,
          detail:
            `${result.range.start} → ${result.range.end}: ${result.totals} daily rows, ` +
            `${result.breakdownA + result.breakdownB} breakdown rows`,
          // Neither source can be attributed to a deal, so there is never an
          // outstanding join to name here.
          remedy: undefined,
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

  // Google's `click_view` last: one request per day, and the only thing here
  // that expires — so it gets whatever budget is left every run, and the
  // ledger it keeps (`click_ingest_days`) carries the backlog to the next.
  if (wanted('google_ads')) {
    for (const connection of await listGoogleAdsConnections()) {
      if (!mine(connection.tenantId)) continue;
      await unit(connection.tenantId, 'google_ads', async () => {
        const context = await resolveGoogleAdsContext(
          connection.tenantId,
          connection.connectionId,
        );
        const result = await runGoogleAdsSync(context, {
          trigger: `${trigger}-clicks`,
          now: startedAt,
          windowDays: Math.max(spendWindowDays, 5),
          maxClickDays: Math.max(spendWindowDays, 5),
          clicksOnly: true,
        });
        const clicks = result.clicks;
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
          detail:
            `${clicks.daysSucceeded}/${clicks.daysAttempted} click days, ` +
            `${clicks.clicksWritten} clicks` + expired,
          remedy: clicks.daysRemaining > 0
            ? `${clicks.daysRemaining} click days still outstanding — the next run continues, or run backfill-clicks.`
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
