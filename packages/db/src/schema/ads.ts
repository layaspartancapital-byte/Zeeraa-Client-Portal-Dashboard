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
import { organicSourceEnum } from './enums';
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
