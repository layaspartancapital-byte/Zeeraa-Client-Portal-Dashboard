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
import { attributionModelEnum } from './enums';
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
    selfReportedRevenue: numeric('self_reported_revenue', { precision: 18, scale: 2 }),
    selfReportedTimeInBusiness: numeric('self_reported_time_in_business', {
      precision: 8,
      scale: 2,
    }),
    industry: text('industry'),
    state: text('state'),
    isDuplicate: boolean('is_duplicate').notNull().default(false),
    duplicateOf: text('duplicate_of'),
    syncRunId: uuid('sync_run_id').references(() => syncRuns.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('leads_tenant_external_key').on(t.tenantId, t.externalId),
    index('leads_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('leads_tenant_click_id_idx').on(t.tenantId, t.clickId),
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
