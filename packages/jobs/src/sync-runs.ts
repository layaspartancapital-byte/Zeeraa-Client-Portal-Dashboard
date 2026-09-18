import { and, desc, eq, inArray } from 'drizzle-orm';
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
