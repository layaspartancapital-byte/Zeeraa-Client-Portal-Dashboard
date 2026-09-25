import { and, eq, like, or, sql } from 'drizzle-orm';
import { manualSyncVerdict } from '@zeeraa/core';
import { schema, withJobTenant, type Database } from '@zeeraa/db';
import { runIncrementalSync, type IncrementalResult, type SyncPlatform } from './incremental';

/**
 * "Sync now", for any member of a tenant (25 September 2026).
 *
 * Three properties make it safe to give a client:
 *
 *   * **It runs as the ingestion role.** Everything here is `withJobTenant`
 *     and `runIncrementalSync`, the cron's own path. The member's session is
 *     only the reason to start; it never touches a write.
 *   * **It syncs one tenant, always named.** `runIncrementalSync` with no
 *     `tenantId` syncs every tenant, so an empty one is refused here rather
 *     than passed through.
 *   * **At most one per tenant every five minutes** (`manualSyncVerdict`),
 *     whoever presses it. The check and the sync share one transaction holding
 *     a per-tenant advisory lock, so two clicks at once cannot both pass it:
 *     the second finds the lock taken and is told a sync is running. Once the
 *     first has written its `sync_runs` rows, their start is the throttle.
 */
export type ManualSyncOutcome =
  | { status: 'ran'; result: IncrementalResult }
  | { status: 'throttled'; lastAt: Date; nextAt: Date; message: string }
  | { status: 'running'; message: string };

export async function runManualSync(options: {
  tenantId: string;
  platforms?: SyncPlatform[];
  now?: Date;
  /** The sync itself; replaced in tests. */
  run?: typeof runIncrementalSync;
  db?: Database;
}): Promise<ManualSyncOutcome> {
  const { tenantId, platforms } = options;
  if (!tenantId) throw new Error('A manual sync names its tenant: without one it would sync every tenant.');
  const now = options.now ?? new Date();
  const run = options.run ?? runIncrementalSync;

  return withJobTenant(
    tenantId,
    async (tx) => {
      const [lock] = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`manual-sync:${tenantId}`}, 0)) as locked`,
      );
      if (!lock?.locked) return { status: 'running', message: 'A sync is already running for this client.' };

      const [last] = await tx
        .select({ at: sql<string | null>`max(${schema.syncRuns.startedAt})` })
        .from(schema.syncRuns)
        .where(
          and(
            eq(schema.syncRuns.tenantId, tenantId),
            or(eq(schema.syncRuns.trigger, 'manual'), like(schema.syncRuns.trigger, 'manual-%')),
          ),
        );
      const verdict = manualSyncVerdict(last?.at ? new Date(last.at) : null, now);
      if (!verdict.allowed) return { status: 'throttled', lastAt: verdict.lastAt, nextAt: verdict.nextAt, message: verdict.message };

      const result = await run({ tenantId, platforms, trigger: 'manual', now });
      return { status: 'ran', result };
    },
    options.db,
  );
}
