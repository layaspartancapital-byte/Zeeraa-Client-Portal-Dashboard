import {
  boolean,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { attributionModelEnum, clickIdSourceEnum, stageOriginEnum } from './enums';
import { tenants } from './tenancy';
import { campaigns } from './ads';
import { syncRuns } from './provenance';

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    /**
     * The whole product depends on this surviving Lead → Opportunity
     * conversion. If it is absent the connector must raise a blocked state
     * rather than write a null and silently drop attribution (§16).
     */
    clickId: text('click_id'),
    clickIdType: text('click_id_type'),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    utmContent: text('utm_content'),
    utmTerm: text('utm_term'),
    landingPage: text('landing_page'),
    /** Monthly gross, as reported. Null when the form captured only an annual figure. */
    selfReportedRevenue: numeric('self_reported_revenue', { precision: 18, scale: 2 }),
    /** Annual gross, as reported. Normalised to a monthly basis at comparison time. */
    selfReportedAnnualRevenue: numeric('self_reported_annual_revenue', {
      precision: 18,
      scale: 2,
    }),
    /**
     * Both figures present and disagreeing beyond the configured tolerance —
     * usually a monthly figure typed into the annual field. Flagged rather than
     * silently reconciled, because it is a correctable data-entry error.
     */
    revenueFiguresDisagree: boolean('revenue_figures_disagree').notNull().default(false),
    selfReportedTimeInBusiness: numeric('self_reported_time_in_business', {
      precision: 8,
      scale: 2,
    }),
    industry: text('industry'),
    state: text('state'),
    isDuplicate: boolean('is_duplicate').notNull().default(false),
    duplicateOf: text('duplicate_of'),
    /**
     * The opportunity this lead became. The only route to a click ID for any
     * opportunity that converted before the Lead→Opportunity field mapping
     * existed, which is why it is stored rather than derived at query time.
     */
    convertedOpportunityId: text('converted_opportunity_id'),
    /**
     * Set when this lead was merged into another. The record did not disappear
     * — its history moved to the survivor, and so does its attribution.
     */
    mergedInto: text('merged_into'),
    syncRunId: uuid('sync_run_id').references(() => syncRuns.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('leads_tenant_external_key').on(t.tenantId, t.externalId),
    index('leads_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('leads_tenant_click_id_idx').on(t.tenantId, t.clickId),
    index('leads_tenant_converted_opp_idx').on(t.tenantId, t.convertedOpportunityId),
  ],
);

export const opportunities = pgTable(
  'opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    leadExternalId: text('lead_external_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    /** Free text: stage vocabulary is per tenant, defined in funnel_stages. */
    currentStage: text('current_stage').notNull(),
    amount: numeric('amount', { precision: 18, scale: 2 }),
    fundedAmount: numeric('funded_amount', { precision: 18, scale: 2 }),
    declineReason: text('decline_reason'),
    industry: text('industry'),
    state: text('state'),
    syncRunId: uuid('sync_run_id').references(() => syncRuns.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('opportunities_tenant_external_key').on(t.tenantId, t.externalId),
    index('opportunities_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('opportunities_tenant_lead_idx').on(t.tenantId, t.leadExternalId),
  ],
);

/**
 * Per-stage timestamps. Mandatory (§4): without these the platform can only
 * ever show a snapshot, never a cohort or a velocity. A stage can legitimately
 * recur, so the uniqueness key includes the instant.
 */
export const stageEvents = pgTable(
  'stage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    opportunityExternalId: text('opportunity_external_id').notNull(),
    stage: text('stage').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /**
     * Whether the CRM recorded this stage or the platform inferred it. MQL has
     * no timestamp field in Salesforce and is computed from the qualification
     * bar, so the distinction has to survive into the UI — a computed stage
     * must never be presented as something the CRM observed.
     */
    origin: stageOriginEnum('origin').notNull().default('observed'),
    syncRunId: uuid('sync_run_id').references(() => syncRuns.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('stage_events_upsert_key').on(
      t.tenantId,
      t.opportunityExternalId,
      t.stage,
      t.occurredAt,
    ),
    index('stage_events_tenant_stage_idx').on(t.tenantId, t.stage, t.occurredAt),
  ],
);

/**
 * Both models are stored for every opportunity from day one. The UI defaults to
 * last touch and exposes the model as a toggle; backfilling a second model
 * later is not possible once click history has aged out.
 */
export const attribution = pgTable(
  'attribution',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    opportunityExternalId: text('opportunity_external_id').notNull(),
    model: attributionModelEnum('model').notNull(),
    platform: text('platform'),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    clickId: text('click_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('attribution_upsert_key').on(t.tenantId, t.opportunityExternalId, t.model),
    index('attribution_tenant_model_campaign_idx').on(t.tenantId, t.model, t.campaignId),
  ],
);

/**
 * Click IDs recovered for an opportunity, and how.
 *
 * Deliberately separate from `attribution`: this is the raw observation, not a
 * model. Attribution decides which touch gets credit; this only records that a
 * given opportunity carried a given platform's click ID, and by which route it
 * was learned.
 *
 * `lead_conversion` rows come from the converted-Lead backfill, which recovers
 * click IDs for opportunities that converted before the Lead→Opportunity field
 * mapping existed. `opportunity_field` rows come from the mapped field itself
 * once it is live. Keeping both lets the two be compared: where they disagree,
 * the field mapping has a gap.
 */
export const opportunityClickIds = pgTable(
  'opportunity_click_ids',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    opportunityExternalId: text('opportunity_external_id').notNull(),
    platform: text('platform').notNull(),
    clickId: text('click_id').notNull(),
    source: clickIdSourceEnum('source').notNull(),
    /** The lead the value was recovered from, for `lead_conversion` rows. */
    leadExternalId: text('lead_external_id'),
    syncRunId: uuid('sync_run_id').references(() => syncRuns.id, { onDelete: 'set null' }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('opportunity_click_ids_upsert_key').on(
      t.tenantId,
      t.opportunityExternalId,
      t.platform,
      t.source,
    ),
    index('opportunity_click_ids_tenant_platform_idx').on(t.tenantId, t.platform),
  ],
);
