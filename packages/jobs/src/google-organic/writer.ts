import { sql } from 'drizzle-orm';
import type { Database } from '@zeeraa/db';
import type { Ga4Row, SearchConsoleRow } from '@zeeraa/connectors';

/**
 * Upsert, never append.
 *
 * Both APIs restate — GA4 reprocesses for about 48 hours, Search Console
 * finalises over two to three days — so the nightly re-pulls the whole window
 * and has to converge on one row per (day, dimension, value) rather than add a
 * second. The same rule as `daily_metrics`, for the same reason.
 *
 * Written as parameterised SQL rather than through the query builder so the
 * conflict target is the exact unique index, and batched because a 90-day pull
 * of per-day query rows is tens of thousands of rows and one statement each
 * would be tens of thousands of round trips.
 */

const BATCH = 1000;

export async function upsertGa4Metrics(
  tx: Database,
  tenantId: string,
  rows: readonly Ga4Row[],
  syncRunId: string,
): Promise<number> {
  return upsertBatched(rows, async (chunk) => {
    const values = chunk.map(
      (row) => sql`(
        ${tenantId}::uuid, ${row.date}::date, ${row.dimension}, ${row.dimensionValue},
        ${String(Math.round(row.sessions))}::numeric,
        ${String(Math.round(row.engagedSessions))}::numeric,
        ${String(Math.round(row.users))}::numeric,
        ${syncRunId}::uuid, now()
      )`,
    );
    const written = await tx.execute<{ id: string }>(sql`
      INSERT INTO ga4_metrics (
        tenant_id, date, dimension, dimension_value,
        sessions, engaged_sessions, users, sync_run_id, updated_at
      )
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (tenant_id, date, dimension, dimension_value)
      DO UPDATE SET
        sessions = excluded.sessions,
        engaged_sessions = excluded.engaged_sessions,
        users = excluded.users,
        sync_run_id = excluded.sync_run_id,
        updated_at = excluded.updated_at
      RETURNING id
    `);
    return rowCount(written);
  });
}

export async function upsertSearchConsoleMetrics(
  tx: Database,
  tenantId: string,
  rows: readonly SearchConsoleRow[],
  syncRunId: string,
): Promise<number> {
  return upsertBatched(rows, async (chunk) => {
    const values = chunk.map(
      (row) => sql`(
        ${tenantId}::uuid, ${row.date}::date, ${row.dimension}, ${row.dimensionValue},
        ${String(Math.round(row.clicks))}::numeric,
        ${String(Math.round(row.impressions))}::numeric,
        ${row.position === null ? null : row.position.toFixed(4)}::numeric,
        ${syncRunId}::uuid, now()
      )`,
    );
    const written = await tx.execute<{ id: string }>(sql`
      INSERT INTO search_console_metrics (
        tenant_id, date, dimension, dimension_value,
        clicks, impressions, position, sync_run_id, updated_at
      )
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (tenant_id, date, dimension, dimension_value)
      DO UPDATE SET
        clicks = excluded.clicks,
        impressions = excluded.impressions,
        position = excluded.position,
        sync_run_id = excluded.sync_run_id,
        updated_at = excluded.updated_at
      RETURNING id
    `);
    return rowCount(written);
  });
}

/**
 * Postgres refuses an ON CONFLICT that hits the same row twice in one
 * statement, so a duplicate key inside the batch is collapsed before it is
 * sent. Both APIs can return the same (day, value) twice when a dimension
 * value differs only by something they normalise away.
 */
async function upsertBatched<T extends { date: string; dimension: string; dimensionValue: string }>(
  rows: readonly T[],
  write: (chunk: T[]) => Promise<number>,
): Promise<number> {
  if (rows.length === 0) return 0;

  const deduped = new Map<string, T>();
  for (const row of rows) {
    deduped.set(`${row.date}|${row.dimension}|${row.dimensionValue}`, row);
  }
  const all = [...deduped.values()];

  let written = 0;
  for (let i = 0; i < all.length; i += BATCH) {
    written += await write(all.slice(i, i + BATCH));
  }
  return written;
}

function rowCount(result: unknown): number {
  return Array.isArray(result) ? result.length : ((result as { length?: number }).length ?? 0);
}
