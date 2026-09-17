import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@zeeraa/db';
import { eachDay, type DateRange } from '@zeeraa/core';
import {
  ClickWindowExpiredError,
  earliestClickDay,
  isWithinClickWindow,
  type ClickRow,
  type Connection,
  type Connector,
} from '@zeeraa/connectors';
import { campaignIdMap, upsertAdClicks } from './writer';

/**
 * The 90-day click backfill, made resumable.
 *
 * A backfill is ninety sequential requests against a quota-limited API. It will
 * fail partway — not might. So the unit of work is one day, the state of each
 * day is a row, and a re-run claims what is outstanding instead of starting
 * again. Nothing here assumes it is the first attempt or the last.
 *
 * Three states matter and they are not interchangeable:
 *
 *   `succeeded` — the day was read and its clicks written.
 *   `failed`    — something went wrong. Worth another attempt.
 *   `expired`   — the day has fallen out of `click_view`'s rolling 90-day
 *                 window. No retry recovers it, and treating it as a failure
 *                 would leave the job retrying impossible requests nightly
 *                 while hiding a permanent hole in the record.
 */

/**
 * Days inside this trailing window are re-pulled even when they already
 * succeeded. Google restates click and conversion data for weeks after the
 * fact, and the same trailing-7-day rule marks a figure provisional in the UI
 * (§12) — a day that is still settling is not a day that is done.
 */
export const DEFAULT_RESETTLE_DAYS = 7;

export type ClickIngestPlan = {
  /** Days to fetch, oldest first. */
  pending: string[];
  /** Days already outside the window. Recorded, never attempted. */
  expired: string[];
  /** Settled, previously succeeded, and skipped this run. */
  settled: string[];
};

/**
 * Writes the ledger for a window and returns what is outstanding.
 *
 * Runs before any fetching, so that a run which dies on its first request still
 * leaves behind a complete record of what it intended to do. Without that, a
 * crash midway through a backfill is indistinguishable from a backfill that was
 * never started.
 */
export async function planClickDays(
  tx: Database,
  tenantId: string,
  platform: string,
  range: DateRange,
  today: string,
  resettleDays = DEFAULT_RESETTLE_DAYS,
): Promise<ClickIngestPlan> {
  const days = eachDay(range);
  if (days.length === 0) return { pending: [], expired: [], settled: [] };

  // Create a row for any day not yet tracked. `DO NOTHING` rather than an
  // update: an existing row carries history — attempts, the last error — and a
  // fresh plan must not reset it.
  await tx
    .insert(schema.clickIngestDays)
    .values(days.map((day) => ({ tenantId, platform, day, status: 'pending' as const })))
    .onConflictDoNothing({
      target: [
        schema.clickIngestDays.tenantId,
        schema.clickIngestDays.platform,
        schema.clickIngestDays.day,
      ],
    });

  const existing = await tx
    .select({
      day: schema.clickIngestDays.day,
      status: schema.clickIngestDays.status,
    })
    .from(schema.clickIngestDays)
    .where(
      and(
        eq(schema.clickIngestDays.tenantId, tenantId),
        eq(schema.clickIngestDays.platform, platform),
        inArray(schema.clickIngestDays.day, days),
      ),
    )
    .orderBy(asc(schema.clickIngestDays.day));

  const plan: ClickIngestPlan = { pending: [], expired: [], settled: [] };
  const newlyExpired: string[] = [];
  const resettleFrom = earliestClickDay(today, resettleDays);

  for (const row of existing) {
    if (!isWithinClickWindow(row.day, today)) {
      plan.expired.push(row.day);
      if (row.status !== 'expired') newlyExpired.push(row.day);
      continue;
    }
    if (row.status === 'succeeded' && row.day < resettleFrom) {
      plan.settled.push(row.day);
      continue;
    }
    plan.pending.push(row.day);
  }

  if (newlyExpired.length > 0) {
    // A day that aged out while the job was not looking. Marked once, so it
    // stops being claimed, and left in place as the record of the hole.
    await tx
      .update(schema.clickIngestDays)
      .set({
        status: 'expired',
        lastError:
          'Aged out of the click_view 90-day window before it was ingested. ' +
          'This click data is not recoverable.',
        completedAt: new Date(),
      })
      .where(
        and(
          eq(schema.clickIngestDays.tenantId, tenantId),
          eq(schema.clickIngestDays.platform, platform),
          inArray(schema.clickIngestDays.day, newlyExpired),
        ),
      );
  }

  return plan;
}

export type ClickIngestResult = {
  daysAttempted: number;
  daysSucceeded: number;
  daysFailed: number;
  daysExpired: number;
  daysRemaining: number;
  clicksWritten: number;
  /** The first error, kept so a run that stopped early can say why. */
  firstError?: string;
};

export type ClickIngestContext = {
  tenantId: string;
  platform: string;
  connection: Connection;
  connector: Connector;
  syncRunId: string;
  today: string;
  /**
   * How many days one run may fetch. A Cloud project at Explorer access level
   * gets 2,880 operations a day against production accounts, so a full 90-day
   * backfill is spread over several nights rather than failing at the quota.
   * The ledger is what makes that safe to do.
   */
  maxDays?: number;
  resettleDays?: number;
};

/**
 * Fetches and writes the outstanding days, one at a time.
 *
 * Deliberately sequential. The constraint is a daily operation quota rather
 * than latency, and a parallel fan-out that trips the quota leaves a scatter of
 * half-written days behind — which is precisely the state the ledger exists to
 * avoid having to reason about.
 *
 * Each day commits its own transaction. A single transaction around ninety
 * days would roll back eighty-nine good ones because the ninetieth failed, and
 * would hold a write lock for the duration.
 */
export async function ingestClicks(
  runInTenant: <T>(fn: (tx: Database) => Promise<T>) => Promise<T>,
  context: ClickIngestContext,
  range: DateRange,
): Promise<ClickIngestResult> {
  const { tenantId, platform, connector, connection, syncRunId, today } = context;

  if (!connector.fetchClicks) {
    throw new Error(
      `The ${connector.key} connector does not expose clicks, so no click-level ` +
        'attribution can be built for it.',
    );
  }

  const plan = await runInTenant((tx) =>
    planClickDays(tx, tenantId, platform, range, today, context.resettleDays),
  );

  const budget = context.maxDays ?? plan.pending.length;
  const todo = plan.pending.slice(0, budget);

  const result: ClickIngestResult = {
    daysAttempted: 0,
    daysSucceeded: 0,
    daysFailed: 0,
    daysExpired: plan.expired.length,
    daysRemaining: plan.pending.length - todo.length,
    clicksWritten: 0,
  };

  for (const day of todo) {
    result.daysAttempted += 1;
    let clicks: ClickRow[];

    try {
      clicks = await connector.fetchClicks(connection, day);
    } catch (error) {
      if (error instanceof ClickWindowExpiredError) {
        // Raced the window edge between planning and fetching. Not a failure.
        await runInTenant((tx) => markDay(tx, tenantId, platform, day, 'expired', 0, syncRunId, error.message));
        result.daysExpired += 1;
        result.daysAttempted -= 1;
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      await runInTenant((tx) => markDay(tx, tenantId, platform, day, 'failed', 0, syncRunId, message));
      result.daysFailed += 1;
      result.firstError ??= `${day}: ${message}`;
      continue;
    }

    try {
      const written = await runInTenant(async (tx) => {
        const campaigns = await campaignIdMap(tx, tenantId, platform);
        const count = await upsertAdClicks(tx, tenantId, platform, clicks, campaigns, syncRunId);
        await markDay(tx, tenantId, platform, day, 'succeeded', count, syncRunId, null);
        return count;
      });
      result.clicksWritten += written;
      result.daysSucceeded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await runInTenant((tx) => markDay(tx, tenantId, platform, day, 'failed', 0, syncRunId, message));
      result.daysFailed += 1;
      result.firstError ??= `${day}: ${message}`;
    }
  }

  return result;
}

async function markDay(
  tx: Database,
  tenantId: string,
  platform: string,
  day: string,
  status: 'succeeded' | 'failed' | 'expired',
  clicksWritten: number,
  syncRunId: string,
  error: string | null,
): Promise<void> {
  await tx
    .update(schema.clickIngestDays)
    .set({
      status,
      clicksWritten: String(clicksWritten),
      // Incremented in SQL rather than read-then-written: two runs racing on the
      // same day must not lose a count between them.
      attempts: sql`${schema.clickIngestDays.attempts} + 1`,
      lastError: error,
      lastAttemptedAt: new Date(),
      completedAt: status === 'succeeded' || status === 'expired' ? new Date() : null,
      syncRunId,
    })
    .where(
      and(
        eq(schema.clickIngestDays.tenantId, tenantId),
        eq(schema.clickIngestDays.platform, platform),
        eq(schema.clickIngestDays.day, day),
      ),
    );
}

/** What the UI needs to render the gap honestly. */
export async function clickCoverage(
  tx: Database,
  tenantId: string,
  platform: string,
): Promise<{ succeeded: number; pending: number; failed: number; expired: number }> {
  const rows = await tx
    .select({
      status: schema.clickIngestDays.status,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.clickIngestDays)
    .where(
      and(
        eq(schema.clickIngestDays.tenantId, tenantId),
        eq(schema.clickIngestDays.platform, platform),
      ),
    )
    .groupBy(schema.clickIngestDays.status);

  const counts = { succeeded: 0, pending: 0, failed: 0, expired: 0 };
  for (const row of rows) counts[row.status] = Number(row.count);
  return counts;
}
