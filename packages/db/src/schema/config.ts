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
import { improvementDirectionEnum } from './enums';
import { tenants } from './tenancy';

/**
 * The funnel is configuration, not code.
 *
 * Spartan runs Lead → MQL → SQL → UW Approved → Offer → Funded; another tenant
 * might run Lead → Demo → Trial → Subscription. There is no `offer_rate`
 * column anywhere — "offer rate" is one instance of stage_conversion_rate(n,
 * n+1) over these rows.
 */
export const funnelStages = pgTable(
  'funnel_stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    /** Carries the brass underline on the funnel view (§9.3). */
    isOptimizationTarget: boolean('is_optimization_target').notNull().default(false),
    /** Whether reaching this stage contributes to funded volume. */
    countsValue: boolean('counts_value').notNull().default(false),
    /**
     * Where this stage is counted from.
     *
     * `stage_events` is the default and is keyed by opportunity. `leads` counts
     * rows in `leads` — the inbound population, since cold outreach is excluded
     * at ingest — and attributes them by `leads.click_id_type`, because a lead
     * that never converted has no opportunity to attribute through.
     * `qualified_leads` is that same population narrowed to leads passing the
     * tenant's bar, for a stage that is a judgement about a lead rather than
     * an event in a CRM.
     *
     * Configuration rather than a special case for the word "lead": a funnel
     * whose first stage is genuinely an opportunity keeps the default, and one
     * that starts further up the pipe says so here.
     */
    source: text('source')
      .notNull()
      .default('stage_events')
      .$type<'stage_events' | 'leads' | 'qualified_leads'>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('funnel_stages_tenant_key_key').on(t.tenantId, t.key),
    uniqueIndex('funnel_stages_tenant_position_key').on(t.tenantId, t.position),
  ],
);

export const tenantMetrics = pgTable(
  'tenant_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    /** Names a function in packages/core. Never an inline formula string. */
    formulaKey: text('formula_key').notNull(),
    /** Arguments the formula needs, e.g. the two stages of a conversion rate. */
    formulaArgs: jsonb('formula_args').notNull().default(sql`'{}'::jsonb`),
    targetValue: numeric('target_value', { precision: 18, scale: 4 }),
    improvementDirection: improvementDirectionEnum('improvement_direction').notNull(),
    isNorthStar: boolean('is_north_star').notNull().default(false),
    /**
     * True where the proposal states two conflicting figures for the same
     * word. These surface in an admin screen for reconciliation; they are never
     * rendered as committed progress (§13).
     */
    needsReconciliation: boolean('needs_reconciliation').notNull().default(false),
    reconciliationNote: text('reconciliation_note'),
    /** Plain-English sentence behind the one-click metric definition (§12). */
    definition: text('definition'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tenant_metrics_tenant_key_key').on(t.tenantId, t.key)],
);

/**
 * Everything else a tenant configures that is not a stage or a metric:
 * qualification minimums, the duplicate cool-off window, working hours.
 * Key/value so a new tenant-specific rule never becomes a migration.
 */
export const tenantConfig = pgTable(
  'tenant_config',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    description: text('description'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tenant_config_tenant_key_key').on(t.tenantId, t.key)],
);

/**
 * A labelled historical snapshot — not live data. Spartan's Google Ads search
 * baseline for 1 Jun–31 Aug 2026 lives here so the executive view can show a
 * "before" without anyone mistaking it for something a connector produced.
 */
export const baselines = pgTable(
  'baselines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    platform: text('platform'),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    metrics: jsonb('metrics').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('baselines_tenant_key_key').on(t.tenantId, t.key)],
);

/** The funded-volume ladder. Thresholds are rows, never constants. */
export const milestones = pgTable(
  'milestones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    metricKey: text('metric_key').notNull(),
    position: integer('position').notNull(),
    label: text('label').notNull(),
    thresholdValue: numeric('threshold_value', { precision: 18, scale: 2 }).notNull(),
    reachedAt: timestamp('reached_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('milestones_tenant_metric_position_key').on(t.tenantId, t.metricKey, t.position)],
);

/**
 * The engagement ramp: what a channel is contracted to reach, month by month.
 *
 * Rows, not constants, for the reason every threshold here is a row — this is
 * what one client signed, and the next will sign something else. `month_index`
 * is 1-based and carries no calendar meaning on its own; M1 lands on whatever
 * month the contract starts, which is `engagement_start_month` in
 * `tenant_config` and is set when the engagement is signed.
 *
 * Per platform, because the model is per platform. Spartan's ramp is Google Ads
 * only; Meta carries no target and must not inherit one — a target drawn on a
 * channel nobody contracted for is a number with no source.
 *
 * Every figure is nullable. The engagement model states a budget, a CPA, an
 * approvals count and a funded-deal count beside each month's cost per funded
 * deal, and a column with no figure yet renders as an absence rather than as a
 * zero, exactly like every other unmeasured thing in this product.
 */
export const engagementTargets = pgTable(
  'engagement_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Connector key: `google_ads`. Never null — a target belongs to a channel. */
    platform: text('platform').notNull(),
    /** 1-based month of the ramp. M1 is the contract's first month. */
    monthIndex: integer('month_index').notNull(),
    costPerFundedDeal: numeric('cost_per_funded_deal', { precision: 18, scale: 2 }),
    budget: numeric('budget', { precision: 18, scale: 2 }),
    cpa: numeric('cpa', { precision: 18, scale: 2 }),
    approvals: integer('approvals'),
    fundedDeals: integer('funded_deals'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('engagement_targets_tenant_platform_month_key').on(
      t.tenantId,
      t.platform,
      t.monthIndex,
    ),
  ],
);

/**
 * Figures the source material states two ways.
 *
 * Several of Spartan's proposal numbers conflict — CPA quoted at $2,000 → $1,000
 * beside a Google Ads cost per conversion of $108.59, a database described as
 * both 1M and 100,000 records. Rendering either version as committed progress
 * would be a fabrication, so they land here and surface in an admin screen
 * until somebody decides which is true (§13).
 */
export const reconciliationItems = pgTable(
  'reconciliation_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    /** Each claim: the figure, and where in the paperwork it appears. */
    claims: jsonb('claims').notNull(),
    question: text('question').notNull(),
    /** Null until reconciled. Nothing downstream may read an unresolved item. */
    resolvedValue: text('resolved_value'),
    resolvedNote: text('resolved_note'),
    resolvedByUserId: uuid('resolved_by_user_id'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('reconciliation_items_tenant_key_key').on(t.tenantId, t.key)],
);

/**
 * A dependency outside Zeeraa's control that is blocking something the UI would
 * otherwise render (§9.5).
 *
 * The brief's rule is that a missing data dependency is an explicit blocked
 * state, never a silent gap — a visible dependency is a conversation, a gap
 * looks like the agency failed. The corollary matters just as much: a stage with
 * no source must not render as a zero, because a zero is a measurement and this
 * is the absence of one.
 *
 * Rows here are configuration, not code. Spartan's MQL stage is blocked because
 * its two inputs are close to empty in their Salesforce org; another tenant's
 * MQL is fine, and the difference is a row rather than a branch.
 */
export const blockedDependencies = pgTable(
  'blocked_dependencies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    /** 'funnel_stage' | 'breakdown' | 'metric'. Constrained in the migration. */
    subjectKind: text('subject_kind').notNull(),
    /** Resolves against `funnel_stages.key`, a view's slice key, or a metric key. */
    subjectKey: text('subject_key').notNull(),
    label: text('label').notNull(),
    /** Why, in a sentence a client can read without translation. */
    reason: text('reason').notNull(),
    /** What would unblock it, and who does it. */
    needed: text('needed'),
    /** The measurement behind the decision, so the judgement is checkable. */
    evidence: text('evidence'),
    blockedSince: timestamp('blocked_since', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('blocked_dependencies_tenant_key_key').on(t.tenantId, t.key),
    index('blocked_dependencies_tenant_subject_idx').on(t.tenantId, t.subjectKind, t.subjectKey),
  ],
);
