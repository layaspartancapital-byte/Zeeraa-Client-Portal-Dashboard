import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenancy';
import { syncRuns } from './provenance';

/**
 * SEO, from Semrush (migration 0042). Monthly snapshots and daily Position
 * Tracking observations are kept in separate tables; the migration says why.
 */

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const syncRunId = () => uuid('sync_run_id').references(() => syncRuns.id, { onDelete: 'set null' });

/** Every read, what it cost, and — by its newest row — whether a report is due. */
export const seoReportReads = pgTable(
  'seo_report_reads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    report: text('report').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
    readOn: date('read_on').notNull(),
    units: integer('units').notNull(),
    rows: integer('rows').notNull(),
    syncRunId: syncRunId(),
  },
  (t) => [index('seo_report_reads_tenant_report_idx').on(t.tenantId, t.report, t.readAt)],
);

export const seoDomainMonths = pgTable(
  'seo_domain_months',
  {
    tenantId: tenantId(),
    database: text('database').notNull(),
    month: date('month').notNull(),
    readOn: date('read_on').notNull(),
    semrushRank: integer('semrush_rank'),
    organicKeywords: integer('organic_keywords').notNull(),
    positions1to3: integer('positions_1_3').notNull(),
    positions4to10: integer('positions_4_10').notNull(),
    positions11to20: integer('positions_11_20').notNull(),
    organicTraffic: integer('organic_traffic').notNull(),
    organicTrafficCost: numeric('organic_traffic_cost', { precision: 14, scale: 2 }).notNull(),
    aiOverviewKeywords: integer('ai_overview_keywords').notNull(),
    aiOverviewCited: integer('ai_overview_cited').notNull(),
    syncRunId: syncRunId(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.database, t.month] })],
);

export const seoBacklinkMonths = pgTable(
  'seo_backlink_months',
  {
    tenantId: tenantId(),
    month: date('month').notNull(),
    readOn: date('read_on').notNull(),
    authorityScore: integer('authority_score').notNull(),
    backlinks: bigint('backlinks', { mode: 'number' }).notNull(),
    referringDomains: integer('referring_domains').notNull(),
    followBacklinks: bigint('follow_backlinks', { mode: 'number' }),
    nofollowBacklinks: bigint('nofollow_backlinks', { mode: 'number' }),
    syncRunId: syncRunId(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.month] })],
);

export const seoKeywords = pgTable(
  'seo_keywords',
  {
    tenantId: tenantId(),
    database: text('database').notNull(),
    month: date('month').notNull(),
    /** 'top_organic' | 'ai_overview'. */
    list: text('list').notNull(),
    keyword: text('keyword').notNull(),
    position: integer('position').notNull(),
    previousPosition: integer('previous_position'),
    searchVolume: integer('search_volume').notNull(),
    cpc: numeric('cpc', { precision: 10, scale: 2 }),
    url: text('url').notNull(),
    trafficShare: numeric('traffic_share', { precision: 7, scale: 2 }),
    keywordDifficulty: numeric('keyword_difficulty', { precision: 5, scale: 2 }),
    intents: text('intents'),
    serpFeatures: text('serp_features'),
    serpFeaturesHeld: text('serp_features_held'),
    readOn: date('read_on').notNull(),
    syncRunId: syncRunId(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.database, t.month, t.list, t.keyword] })],
);

export const seoCompetitors = pgTable(
  'seo_competitors',
  {
    tenantId: tenantId(),
    database: text('database').notNull(),
    month: date('month').notNull(),
    domain: text('domain').notNull(),
    relevance: numeric('relevance', { precision: 6, scale: 4 }).notNull(),
    commonKeywords: integer('common_keywords').notNull(),
    organicKeywords: integer('organic_keywords').notNull(),
    organicTraffic: integer('organic_traffic').notNull(),
    organicTrafficCost: numeric('organic_traffic_cost', { precision: 14, scale: 2 }).notNull(),
    readOn: date('read_on').notNull(),
    syncRunId: syncRunId(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.database, t.month, t.domain] })],
);

export const seoReferringDomainChanges = pgTable(
  'seo_referring_domain_changes',
  {
    tenantId: tenantId(),
    /** 'new' | 'lost'. */
    change: text('change').notNull(),
    domain: text('domain').notNull(),
    authorityScore: integer('authority_score').notNull(),
    backlinks: integer('backlinks').notNull(),
    firstSeen: date('first_seen').notNull(),
    lastSeen: date('last_seen').notNull(),
    readOn: date('read_on').notNull(),
    syncRunId: syncRunId(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.change, t.domain] })],
);

export const seoSiteAudits = pgTable(
  'seo_site_audits',
  {
    tenantId: tenantId(),
    projectId: bigint('project_id', { mode: 'number' }).notNull(),
    snapshotId: text('snapshot_id').notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    finishedOn: date('finished_on').notNull(),
    healthScore: integer('health_score').notNull(),
    aiSearchScore: integer('ai_search_score'),
    thematicScores: jsonb('thematic_scores').$type<Record<string, number>>().notNull().default({}),
    pagesCrawled: integer('pages_crawled').notNull(),
    pagesLimit: integer('pages_limit').notNull(),
    errors: integer('errors').notNull(),
    warnings: integer('warnings').notNull(),
    notices: integer('notices').notNull(),
    readOn: date('read_on').notNull(),
    syncRunId: syncRunId(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.snapshotId] })],
);

export const seoSiteAuditIssues = pgTable(
  'seo_site_audit_issues',
  {
    tenantId: tenantId(),
    snapshotId: text('snapshot_id').notNull(),
    issueId: integer('issue_id').notNull(),
    /** 'error' | 'warning' | 'notice'. */
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    count: integer('count').notNull(),
    delta: integer('delta').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.snapshotId, t.issueId] })],
);

export const seoTrackedPositions = pgTable(
  'seo_tracked_positions',
  {
    tenantId: tenantId(),
    campaignId: text('campaign_id').notNull(),
    day: date('day').notNull(),
    keyword: text('keyword').notNull(),
    /** Null outside the top 100. Never zero. */
    position: integer('position'),
    url: text('url'),
    searchVolume: integer('search_volume'),
    syncRunId: syncRunId(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.campaignId, t.day, t.keyword] })],
);

export const seoTrackingVisibility = pgTable(
  'seo_tracking_visibility',
  {
    tenantId: tenantId(),
    campaignId: text('campaign_id').notNull(),
    day: date('day').notNull(),
    visibility: numeric('visibility', { precision: 7, scale: 3 }).notNull(),
    syncRunId: syncRunId(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.campaignId, t.day] })],
);
