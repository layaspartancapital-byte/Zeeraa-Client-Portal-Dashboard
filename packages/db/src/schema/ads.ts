import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { clickIngestStatusEnum, organicSourceEnum } from './enums';
import { tenants } from './tenancy';
import { syncRuns } from './provenance';

export const adAccounts = pgTable(
  'ad_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    externalAccountId: text('external_account_id').notNull(),
    name: text('name').notNull(),
    /** The platform's own reporting zone, kept for reconciliation only. */
    accountTimezone: text('account_timezone'),
    currency: text('currency'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ad_accounts_tenant_platform_external_key').on(
      t.tenantId,
      t.platform,
      t.externalAccountId,
    ),
  ],
);

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    adAccountId: uuid('ad_account_id').references(() => adAccounts.id, { onDelete: 'set null' }),
    platform: text('platform').notNull(),
    externalCampaignId: text('external_campaign_id').notNull(),
    name: text('name').notNull(),
    status: text('status'),
    /**
     * The platform's own classification, verbatim — Google's
     * `advertising_channel_type`, Meta's `objective`. Not a shared taxonomy:
     * each platform page labels and maps it in that platform's own word, and
     * nothing groups it across platforms.
     */
    campaignType: text('campaign_type'),
    /** Classification fields, filled by Zeeraa rather than by the platform. */
    product: text('product'),
    industry: text('industry'),
    keywordTier: text('keyword_tier'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('campaigns_tenant_platform_external_key').on(
      t.tenantId,
      t.platform,
      t.externalCampaignId,
    ),
    index('campaigns_tenant_platform_idx').on(t.tenantId, t.platform),
    index('campaigns_tenant_platform_type_idx').on(t.tenantId, t.platform, t.campaignType),
  ],
);

/**
 * One row per tenant-local day, platform and campaign.
 *
 * Written by upsert, never by append (§16). Google and Meta restate
 * conversions for 30+ days, so the nightly job re-pulls a trailing 90-day
 * window and overwrites; an append would double-count every restatement.
 *
 * `campaign_id` is null for account-level rows a platform cannot break down.
 * The unique index coalesces it so those rows still deduplicate — a plain
 * unique constraint would let nulls collide freely.
 */
export const dailyMetrics = pgTable(
  'daily_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    date: date('date').notNull(),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    impressions: numeric('impressions', { precision: 20, scale: 0 }).notNull().default('0'),
    clicks: numeric('clicks', { precision: 20, scale: 0 }).notNull().default('0'),
    spend: numeric('spend', { precision: 18, scale: 4 }).notNull().default('0'),
    /**
     * Kept as reported, fractions included — Google Ads returns 622.86 because
     * of fractional attribution. Rounding happens at render, never at ingest.
     */
    platformConversions: numeric('platform_conversions', { precision: 18, scale: 4 })
      .notNull()
      .default('0'),
    /**
     * People reached. Meta reports it, Google does not, and null means exactly
     * that rather than nobody.
     *
     * **Not additive.** Meta deduplicates people across the range it is asked
     * for, so summing days double-counts anyone who saw an ad twice. Stored at
     * the grain it is reported at; the UI refuses to total it.
     */
    reach: numeric('reach', { precision: 20, scale: 0 }),
    /**
     * Every click the platform counts, where it separates that from a click
     * that goes somewhere. Meta reports both; Google reports one number and
     * this is null there. `clicks` stays the comparable one.
     */
    clicksAll: numeric('clicks_all', { precision: 20, scale: 0 }),
    syncRunId: uuid('sync_run_id').references(() => syncRuns.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('daily_metrics_upsert_key').on(
      t.tenantId,
      t.platform,
      t.date,
      sql`coalesce(${t.campaignId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    index('daily_metrics_tenant_date_idx').on(t.tenantId, t.date),
    index('daily_metrics_tenant_platform_date_idx').on(t.tenantId, t.platform, t.date),
  ],
);

export const organicMetrics = pgTable(
  'organic_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    source: organicSourceEnum('source').notNull(),
    /** e.g. 'clicks', 'impressions', 'position:mca loans', 'backlinks'. */
    dimension: text('dimension').notNull(),
    value: numeric('value', { precision: 18, scale: 4 }).notNull(),
    syncRunId: uuid('sync_run_id').references(() => syncRuns.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('organic_metrics_upsert_key').on(t.tenantId, t.source, t.date, t.dimension),
    index('organic_metrics_tenant_date_idx').on(t.tenantId, t.date),
  ],
);

export const aiVisibility = pgTable(
  'ai_visibility',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Sweep period, stored as its first day. */
    period: date('period').notNull(),
    prompt: text('prompt').notNull(),
    engine: text('engine').notNull(),
    cited: boolean('cited').notNull(),
    competitorCited: text('competitor_cited'),
    position: integer('position'),
    syncRunId: uuid('sync_run_id').references(() => syncRuns.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ai_visibility_upsert_key').on(t.tenantId, t.period, t.engine, t.prompt),
  ],
);

/**
 * One row per click the platform charged for, keyed by its click id.
 *
 * This is the half of the spend-to-funded join that expires. A `gclid` on a
 * Salesforce lead is durable; the row here that says which campaign that click
 * belonged to is served by Google for only 90 days, after which the click is
 * permanently unattributable. See docs/brief-amendments.md, "§6 and §7 —
 * `click_view`".
 *
 * `reportedDate` is the *ad account's* calendar day, not the tenant's. Daily
 * spend arrives pre-aggregated on that boundary with no finer grain to
 * re-bucket from, so shifting it would invent an hourly split that was never
 * reported. Where the two zones differ the connector says so rather than
 * silently relabelling somebody else's midnight.
 */
export const adClicks = pgTable(
  'ad_clicks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    /** The platform's own click identifier: a gclid, an msclkid, an fbclid. */
    clickId: text('click_id').notNull(),
    reportedDate: date('reported_date').notNull(),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    externalAdGroupId: text('external_ad_group_id'),
    adNetworkType: text('ad_network_type'),
    device: text('device'),
    syncRunId: uuid('sync_run_id').references(() => syncRuns.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Upsert, never append — the same rule as daily_metrics (§16). Re-running a
    // day that half-succeeded has to converge rather than duplicate.
    uniqueIndex('ad_clicks_upsert_key').on(t.tenantId, t.platform, t.clickId),
    index('ad_clicks_tenant_platform_date_idx').on(t.tenantId, t.platform, t.reportedDate),
    index('ad_clicks_tenant_campaign_idx').on(t.tenantId, t.campaignId),
  ],
);

/**
 * The ledger that makes a 90-day click backfill resumable.
 *
 * A backfill is 90 sequential requests against a quota-limited API, so it will
 * fail partway — that is a certainty to design for, not a risk to mitigate.
 * One row per tenant, platform and day, carrying what happened to that day, so
 * a re-run claims what is outstanding instead of starting again.
 *
 * Kept separate from `sync_runs`: a sync run is one attempt, and this is the
 * state of the work itself, which outlives any particular attempt.
 */
export const clickIngestDays = pgTable(
  'click_ingest_days',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    /** The ad account's calendar day, as queried. */
    day: date('day').notNull(),
    status: clickIngestStatusEnum('status').notNull().default('pending'),
    clicksWritten: numeric('clicks_written', { precision: 12, scale: 0 }).notNull().default('0'),
    /** Retries so far. A day that keeps failing stops looking like a new problem. */
    attempts: numeric('attempts', { precision: 4, scale: 0 }).notNull().default('0'),
    lastError: text('last_error'),
    lastAttemptedAt: timestamp('last_attempted_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    syncRunId: uuid('sync_run_id').references(() => syncRuns.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('click_ingest_days_key').on(t.tenantId, t.platform, t.day),
    index('click_ingest_days_tenant_status_idx').on(t.tenantId, t.platform, t.status, t.day),
  ],
);
