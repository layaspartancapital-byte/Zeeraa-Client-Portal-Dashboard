import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { addDays, eachDay, type DateRange } from '@zeeraa/core';
import { schema, type Database } from '@zeeraa/db';
import type { ExclusionCounts } from '@zeeraa/connectors';

/**
 * The `sync_runs` ledger, shared by every connector.
 *
 * One row per ingestion attempt, which is what anybody debugs from when a
 * client asks why yesterday's spend is missing (§7). Platform-agnostic on
 * purpose: these were originally Salesforce-only and hardcoded the platform,
 * which would have written every Google Ads run into the Salesforce history.
 */

export async function openSyncRun(
  tx: Database,
  tenantId: string,
  trigger: string,
  startedAt: Date,
  platform = 'salesforce',
): Promise<string> {
  const [row] = await tx
    .insert(schema.syncRuns)
    .values({ tenantId, platform, trigger, startedAt, status: 'running' })
    .returning({ id: schema.syncRuns.id });
  return row!.id;
}

export async function closeSyncRun(
  tx: Database,
  syncRunId: string,
  status: 'succeeded' | 'partial' | 'failed',
  rowsWritten: number,
  error: string | null,
  exclusions?: ExclusionCounts,
): Promise<void> {
  await tx
    .update(schema.syncRuns)
    .set({
      finishedAt: new Date(),
      status,
      rowsWritten: String(rowsWritten),
      error,
      // Written on a failed run too. A run that died halfway still refused
      // records before it died, and the count is the evidence for what the
      // partial numbers mean.
      ...(exclusions ? { exclusions } : {}),
    })
    .where(eq(schema.syncRuns.id, syncRunId));
}

/**
 * The high-water mark: the start of the last run that actually finished.
 *
 * Deliberately the *started* time of that run, not its finished time. A record
 * modified while a sync was in flight would otherwise fall into the gap between
 * the two and never be picked up.
 */
/**
 * The last run that finished reading, whether or not every mapped field
 * existed.
 *
 * Distinct from `lastSuccessfulWatermark`, which requires `succeeded` and is
 * the right default for the nightly. `partial` in this codebase means a named
 * field was absent from the org and dropped from the query — the records in
 * the window were still fully enumerated — so for deciding "what changed since
 * we last looked" it is a valid starting point, and treating it as invalid is
 * what turns an hourly incremental into an hourly full pull.
 *
 * `failed` is excluded: a run that threw may have read nothing, and advancing
 * past it would skip records permanently.
 */
export async function lastCompletedWatermark(
  tx: Database,
  tenantId: string,
  platform = 'salesforce',
): Promise<Date | null> {
  const [row] = await tx
    .select({ startedAt: schema.syncRuns.startedAt })
    .from(schema.syncRuns)
    .where(
      and(
        eq(schema.syncRuns.tenantId, tenantId),
        eq(schema.syncRuns.platform, platform),
        inArray(schema.syncRuns.status, ['succeeded', 'partial']),
      ),
    )
    .orderBy(desc(schema.syncRuns.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}

export async function lastSuccessfulWatermark(
  tx: Database,
  tenantId: string,
  platform = 'salesforce',
): Promise<Date | null> {
  const [row] = await tx
    .select({ startedAt: schema.syncRuns.startedAt })
    .from(schema.syncRuns)
    .where(
      and(
        eq(schema.syncRuns.tenantId, tenantId),
        eq(schema.syncRuns.platform, platform),
        eq(schema.syncRuns.status, 'succeeded'),
      ),
    )
    .orderBy(desc(schema.syncRuns.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}

/**
 * The window a windowed source can speak for.
 *
 * Some facts are only knowable inside a horizon. Salesforce field history
 * begins when tracking was switched on and ages out by retention, so a stage
 * derived from it is measured *and* incomplete — and the incompleteness moves
 * forward on its own as old rows expire. Recording the observed window on every
 * run keeps the coverage note honest without anybody remembering to update a
 * constant.
 *
 * `asOf` here is the earliest moment the source can answer for, not the latest
 * it was refreshed. That is the opposite of its meaning for a point-in-time
 * fact, so the `factKey` says `window:` to make the reading unambiguous.
 */
export async function recordSourceWindow(
  tx: Database,
  tenantId: string,
  factKey: string,
  platform: string,
  earliest: Date,
  syncRunId: string,
): Promise<void> {
  await tx
    .insert(schema.dataSources)
    .values({ tenantId, factKey: `window:${factKey}`, kind: 'api', platform, syncRunId, asOf: earliest })
    .onConflictDoUpdate({
      target: [schema.dataSources.tenantId, schema.dataSources.factKey],
      set: { asOf: earliest, syncRunId, platform, kind: 'api' },
    });
}

/** Reads a window recorded by `recordSourceWindow`. Null when none exists. */
export async function readSourceWindow(
  tx: Database,
  tenantId: string,
  factKey: string,
): Promise<Date | null> {
  const [row] = await tx
    .select({ asOf: schema.dataSources.asOf })
    .from(schema.dataSources)
    .where(
      and(
        eq(schema.dataSources.tenantId, tenantId),
        eq(schema.dataSources.factKey, `window:${factKey}`),
      ),
    )
    .limit(1);
  return row?.asOf ?? null;
}

/* ------------------------------------------------------------------------- */
/* Which days a pull covered (migration 0030)                                */
/* ------------------------------------------------------------------------- */

/**
 * Records every day a successful pull covered, and whether it was final.
 *
 * A day is final when it had settled before the pull: over in the tenant's
 * zone, plus `settleDays` for a source that keeps filling in a finished day
 * (GA4 processes for a day or so). A day read while still open is covered but
 * not final, so the next run comes back for it — which is exactly what 18
 * September never got. Once final, a later non-final read cannot un-final it.
 */
export async function recordSyncedDays(
  tx: Database,
  tenantId: string,
  platform: string,
  range: DateRange,
  options: { today: string; settleDays?: number; syncRunId: string | null },
): Promise<number> {
  const settleDays = options.settleDays ?? 0;
  const lastFinal = addDays(options.today, -1 - settleDays);
  const days = eachDay(range).filter((d) => d <= options.today);
  if (days.length === 0) return 0;
  await tx
    .insert(schema.syncDays)
    .values(
      days.map((day) => ({
        tenantId,
        platform,
        day,
        final: day <= lastFinal,
        syncedAt: new Date(),
        syncRunId: options.syncRunId,
      })),
    )
    .onConflictDoUpdate({
      target: [schema.syncDays.tenantId, schema.syncDays.platform, schema.syncDays.day],
      set: {
        final: sql`${schema.syncDays.final} or excluded.final`,
        syncedAt: sql`excluded.synced_at`,
        syncRunId: sql`excluded.sync_run_id`,
      },
    });
  return days.length;
}

/**
 * Where a platform's next pull should start: the oldest day in the lookback
 * that has never been read final, or the routine window, whichever is earlier.
 *
 * This is what makes a missed run self-healing. The window used to be a fixed
 * two days, so three days without a run left a hole nothing ever went back
 * for. `maxDays` bounds the catch-up to what one request can carry; the
 * nightly re-pull covers anything older.
 */
export async function resumeWindow(
  tx: Database,
  tenantId: string,
  platform: string,
  options: { today: string; floorDays: number; maxDays: number; lastDay?: string },
): Promise<DateRange> {
  const end = options.lastDay ?? options.today;
  const floorStart = addDays(end, -(options.floorDays - 1));
  const lookbackStart = addDays(end, -(options.maxDays - 1));
  const finals = await tx
    .select({ day: sql<string>`to_char(${schema.syncDays.day}, 'YYYY-MM-DD')` })
    .from(schema.syncDays)
    .where(
      and(
        eq(schema.syncDays.tenantId, tenantId),
        eq(schema.syncDays.platform, platform),
        eq(schema.syncDays.final, true),
        gte(schema.syncDays.day, lookbackStart),
        lte(schema.syncDays.day, end),
      ),
    );
  const done = new Set(finals.map((r) => r.day));
  const oldestOpen = eachDay({ start: lookbackStart, end: addDays(floorStart, -1) }).find(
    (d) => !done.has(d),
  );
  return { start: oldestOpen ?? floorStart, end };
}

/**
 * A platform the runner did not reach, as a row rather than as an absence.
 *
 * Before this, a skipped unit wrote nothing, so four days without a Meta read
 * looked the same in the ledger as four days nobody had asked about.
 */
export async function recordSkippedRun(
  tx: Database,
  tenantId: string,
  platform: string,
  trigger: string,
  startedAt: Date,
  detail: string,
): Promise<void> {
  await tx.insert(schema.syncRuns).values({
    tenantId,
    platform,
    trigger,
    startedAt,
    finishedAt: new Date(),
    status: 'skipped',
    rowsWritten: '0',
    error: detail,
  });
}

/**
 * When a Salesforce sync for this tenant started, if one is still running.
 *
 * Only runs started in the ten minutes before `now` count: the schedule is
 * every ten minutes and a run takes seconds, so an older `running` row is a
 * run that died without closing, not one in progress.
 */
export async function salesforceRunInFlight(
  tx: Database,
  tenantId: string,
  now: Date,
  withinMinutes = 10,
): Promise<Date | null> {
  const since = new Date(now.getTime() - withinMinutes * 60_000);
  const [row] = await tx
    .select({ startedAt: schema.syncRuns.startedAt })
    .from(schema.syncRuns)
    .where(
      and(
        eq(schema.syncRuns.tenantId, tenantId),
        eq(schema.syncRuns.platform, 'salesforce'),
        eq(schema.syncRuns.status, 'running'),
        gte(schema.syncRuns.startedAt, since),
        lte(schema.syncRuns.startedAt, now),
      ),
    )
    .orderBy(desc(schema.syncRuns.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}
