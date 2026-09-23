import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
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

/**
 * What reached a webhook endpoint, whether or not anything came of it.
 *
 * A pushed source has no sync run to fail, so its silence has no shape — and
 * the Aloware endpoint spent four days refusing every post for two unrelated
 * reasons with no trace of either in the database. A rejected delivery answers
 * 200 on purpose (a webhook sender retries a non-2xx forever), counts its
 * reasons into the response body, and throws them away.
 *
 * **One bucket per tenant per source per day, not a row per delivery.** The
 * endpoint is public, so a row per POST is a stranger's way of growing a table
 * without limit; a counter is bounded however hard anybody pushes on it. Nobody
 * needs the three hundred rows, they need to know there were three hundred and
 * why three hundred were refused.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** The connector key, as `sync_runs.platform` writes it: `aloware`. */
    source: text('source').notNull(),
    /** The tenant's local day. Normalised at ingest, like every date here. */
    day: date('day').notNull(),
    /**
     * Requests that reached the handler for this tenant, refusals included.
     *
     * The count that answers "has anything ever arrived", which is the whole
     * reason the table exists.
     */
    received: integer('received').notNull().default(0),
    /** Rows upserted, and records the reader refused. One POST may be a batch. */
    accepted: integer('accepted').notNull().default(0),
    rejected: integer('rejected').notNull().default(0),
    /**
     * reason -> count, mixing requests and records on purpose.
     *
     * A request refused before its body was read has no records to count, and
     * `unauthenticated: 40` is the most actionable line this table can carry.
     */
    reasons: jsonb('reasons').notNull().default(sql`'{}'::jsonb`),
    firstReceivedAt: timestamp('first_received_at', { withTimezone: true }).notNull().defaultNow(),
    lastReceivedAt: timestamp('last_received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('webhook_deliveries_tenant_source_day_key').on(t.tenantId, t.source, t.day)],
);

/**
 * Which days each source has been read for (migration 0030).
 *
 * One row per tenant, platform and tenant-local day a successful pull covered.
 * `final` is whether that pull came after the day had settled: a day read while
 * it was still in progress is covered but not final, and the next run resumes
 * from the oldest day that is not. The screens read it to mark an unread day
 * inside a range `Not measured`, where the last sync run alone would have made
 * it look like a quiet day.
 */
export const syncDays = pgTable(
  'sync_days',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    day: date('day').notNull(),
    final: boolean('final').notNull().default(false),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    syncRunId: uuid('sync_run_id').references(() => syncRuns.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('sync_days_tenant_platform_day_key').on(t.tenantId, t.platform, t.day)],
);
