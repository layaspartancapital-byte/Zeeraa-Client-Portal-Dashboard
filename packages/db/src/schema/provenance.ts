import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { dataSourceKindEnum, syncStatusEnum } from './enums';
import { tenants, users } from './tenancy';

/**
 * One row per ingestion attempt. Visible on the sync-history page, which is
 * what anyone debugs from when a client asks why yesterday's spend is missing.
 */
export const syncRuns = pgTable(
  'sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    /** e.g. 'nightly', 'hourly_incremental', 'backfill', 'manual'. */
    trigger: text('trigger').notNull().default('scheduled'),
    windowStart: timestamp('window_start', { withTimezone: true }),
    windowEnd: timestamp('window_end', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    rowsWritten: numeric('rows_written', { precision: 12, scale: 0 }).notNull().default('0'),
    status: syncStatusEnum('status').notNull().default('running'),
    error: text('error'),
    attempt: numeric('attempt', { precision: 4, scale: 0 }).notNull().default('1'),
    /**
     * What this run refused to ingest, and why. Shape: `ExclusionCounts` from
     * @zeeraa/connectors — a per-rule breakdown plus the unclassified residue.
     *
     * Recorded because an exclusion that cannot be audited is indistinguishable
     * from a connector quietly dropping records. The `unclassified` figure is
     * the one to watch: a future bulk load will not match today's rules, and it
     * lands there as a number rather than as unexplained funnel growth.
     */
    exclusions: jsonb('exclusions').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [index('sync_runs_tenant_platform_started_idx').on(t.tenantId, t.platform, t.startedAt)],
);

/**
 * The provenance registry (§4, §12).
 *
 * Every fact rendered in the UI resolves through here to either an API sync, a
 * named person. A number with no row here never
 * renders — the UI shows an explicit empty state instead.
 *
 * `factKey` identifies the fact at the grain it is displayed, e.g.
 * 'delivery:articles:2026-10' or 'daily_metrics:google_ads:2026-09-16'.
 */
export const dataSources = pgTable(
  'data_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    factKey: text('fact_key').notNull(),
    kind: dataSourceKindEnum('kind').notNull(),
    platform: text('platform'),
    syncRunId: uuid('sync_run_id').references(() => syncRuns.id, { onDelete: 'set null' }),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Asset ids standing behind a derived figure. */
    assetIds: jsonb('asset_ids').notNull().default(sql`'[]'::jsonb`),
    asOf: timestamp('as_of', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('data_sources_tenant_fact_key').on(t.tenantId, t.factKey)],
);
