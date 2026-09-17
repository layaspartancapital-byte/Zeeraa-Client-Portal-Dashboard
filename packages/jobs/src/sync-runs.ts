import { and, desc, eq } from 'drizzle-orm';
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
