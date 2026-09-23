import {
  boolean,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  attributionModelEnum,
  callDirectionEnum,
  callOutcomeEnum,
  callSourceEnum,
  clickIdSourceEnum,
  mqlVerdictEnum,
  stageOriginEnum,
  submissionOutcomeEnum,
} from './enums';
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
     * The tenant-local calendar day of `created_at`, written at ingest from
     * `tenants.timezone`. Reports bucket and filter on this, never on the
     * instant — `to_char` on a UTC session files 9pm Eastern under tomorrow.
     * Nullable only until the deploy that writes it has shipped (see 0024).
     */
    createdOn: date('created_on', { mode: 'string' }),
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
    /**
     * The qualification bar's verdict on this lead, resolved at ingest.
     *
     * The verdict rather than a resolved number, deliberately. The inputs are
     * bands, and the only number a band yields is one of its bounds — which
     * reproduces the verdict correctly but is not the merchant's revenue. Put
     * in `self_reported_revenue` it would be read as one by anything banding
     * leads by revenue, so the judgement is stored and the bound is not.
     *
     * Null means the bar has not been evaluated for this lead yet, which is
     * distinct from `undeterminable` — that is an answer.
     */
    mqlVerdict: mqlVerdictEnum('mql_verdict'),
    /**
     * Why the verdict is `undeterminable`, in the interface's voice.
     *
     * Coverage without a cause is a number nobody can act on: "31% of leads
     * cannot be evaluated" invites a guess, while "the best-populated
     * time-in-business field is an undecoded flag" names the thing to fix.
     */
    mqlUndeterminableReason: text('mql_undeterminable_reason'),
    selfReportedTimeInBusiness: numeric('self_reported_time_in_business', {
      precision: 8,
      scale: 2,
    }),
    /**
     * The merchant's phone number, and its join key.
     *
     * Here because the dialer knows nothing about a lead except the number it
     * called. `phone_key` is ten digits — normalised at ingest, like dates —
     * and is what calls join on; `phone` keeps what the CRM actually held, so
     * a number that cannot be keyed can still be investigated. PII, and
     * rendered on no screen.
     */
    phone: text('phone'),
    phoneKey: text('phone_key'),
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
    index('leads_tenant_created_on_idx').on(t.tenantId, t.createdOn),
    // The call join runs over this on every speed-to-lead query.
    index('leads_tenant_phone_key_idx').on(t.tenantId, t.phoneKey),
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
    /**
     * The CRM's own deal type, verbatim — `Renewal`, `New Business`, null.
     * Read by the `renewal_exclusion` config row at ingest; stored so the
     * exclusion can be audited and revisited without a re-pull.
     */
    dealType: text('deal_type'),
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
     * The tenant-local calendar day of `occurred_at`, written at ingest from
     * `tenants.timezone`. Reports bucket and filter on this, never on the
     * instant — `to_char` on a UTC session files 9pm Eastern under tomorrow.
     * Nullable only until the deploy that writes it has shipped (see 0024).
     */
    occurredOn: date('occurred_on', { mode: 'string' }),
    /**
     * `month` when only the month is known — a hand-recorded correction whose
     * day nobody can establish. `occurred_at` is then the first instant of
     * that month and must not feed a duration.
     */
    occurredPrecision: text('occurred_precision').notNull().default('instant'),
    /**
     * Why a real event is not counted, or null when it is. Set at ingest by a
     * configured rule — a renewal reaching Funded is not marketing's deal.
     * Every report filters on this; the row stays so the exclusion is auditable.
     */
    excludedReason: text('excluded_reason'),
    /** For `origin = 'corrected'`: who corrected it, and on what evidence. */
    correctionSource: text('correction_source'),
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
    index('stage_events_tenant_stage_on_idx').on(t.tenantId, t.stage, t.occurredOn),
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

/**
 * One deal's submission to one lender.
 *
 * The grain the business actually runs at, and the grain the funnel was missing.
 * A deal is shopped to several lenders at once — Spartan's median is four — and
 * each lender answers separately, so approve, offer and decline are *lender*
 * events. Reading them off the opportunity flattens four answers into one
 * field and loses which lender said what, which is why deal-level offer rate
 * came out at 58.8% against 18.2% at this grain.
 *
 * `lender_name` is denormalised on purpose. The lender is an Account in the
 * CRM, and the platform does not ingest Accounts — it has no use for 25,358 of
 * them — so the name arrives with the submission and is stored beside it. It is
 * a label on a dimension, not an entity this product owns.
 *
 * `status_changed_at` is a proxy and named as one. History tracking on the
 * submission object records only creation, so a lender's decline carries no
 * timestamp of its own; `LastModifiedDate` is the closest available and any
 * other edit moves it. Timing claims must not be built on it without saying so.
 */
export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    opportunityExternalId: text('opportunity_external_id').notNull(),
    lenderExternalId: text('lender_external_id'),
    lenderName: text('lender_name'),
    /** The client's own picklist value, kept verbatim. */
    status: text('status'),
    outcome: submissionOutcomeEnum('outcome').notNull(),
    /**
     * Why a submission is undecided, where the status says. Open and failed are
     * both outside the denominator but they are not the same thing, and a
     * pipeline of 687 open submissions is a different fact from 12 that broke.
     */
    undecidedReason: text('undecided_reason'),
    /**
     * Decline reasons, as given. A multipicklist, so a lender can cite several
     * for one submission — which means a breakdown by reason counts more
     * citations than declines and must never be rendered as a share of deals.
     */
    declineReasons: text('decline_reasons').array(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
    /**
     * The tenant-local calendar day of `submitted_at`, written at ingest from
     * `tenants.timezone`. Reports bucket and filter on this, never on the
     * instant — `to_char` on a UTC session files 9pm Eastern under tomorrow.
     * Nullable only until the deploy that writes it has shipped (see 0024).
     */
    submittedOn: date('submitted_on', { mode: 'string' }),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    syncRunId: uuid('sync_run_id').references(() => syncRuns.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('submissions_upsert_key').on(t.tenantId, t.externalId),
    index('submissions_tenant_opportunity_idx').on(t.tenantId, t.opportunityExternalId),
    index('submissions_tenant_submitted_on_idx').on(t.tenantId, t.submittedOn),
    index('submissions_tenant_outcome_idx').on(t.tenantId, t.outcome, t.submittedAt),
    index('submissions_tenant_lender_idx').on(t.tenantId, t.lenderExternalId, t.outcome),
  ],
);

/**
 * One call, from the dialer.
 *
 * Read from Aloware directly rather than from the `Aloware_Call__c` object in
 * Salesforce. That object exists and holds 30,093 rows, but it is a copy whose
 * completeness depends on the vendor's own Salesforce integration — and a gap
 * in that integration would be indistinguishable here from a quiet day on the
 * phones. A metric this product publishes should not rest on a third party's
 * sync of a third party.
 *
 * **`external_id` is Aloware's Communication ID**, and the upsert key. A
 * re-import of an overlapping export and a webhook re-delivery of the same call
 * both land on the same row, which is the only reason those two routes can
 * safely coexist.
 *
 * PII: `contact_number` is a real merchant's phone number and `agent_name` a
 * real person's name. Both are tenant-scoped like everything else here, and
 * neither is rendered on any screen — the UI shows aggregates, coverage and
 * durations. Nothing about the call carries the recording, the transcript, the
 * contact's name or their email, all of which the export contains and none of
 * which this platform needs.
 */
export const calls = pgTable(
  'calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Aloware's Communication ID. */
    externalId: text('external_id').notNull(),
    /** Normalised into the tenant timezone at ingest; the export has no offset. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /**
     * The tenant-local calendar day of `occurred_at`, written at ingest from
     * `tenants.timezone`. A call at 9pm Eastern is that day's call; `to_char`
     * on a UTC session filed it under tomorrow. Nullable until after 0024.
     */
    occurredOn: date('occurred_on', { mode: 'string' }),
    direction: callDirectionEnum('direction').notNull(),
    outcome: callOutcomeEnum('outcome').notNull(),
    /** The vendor's own status, verbatim, so a reclassification is a query. */
    disposition: text('disposition'),
    /**
     * True for a completed call under the connected threshold — answered by
     * something, over in seconds. Counted as attempted, kept visible because
     * 13,376 of them is a finding about the list rather than about the desk.
     */
    answeredBriefly: boolean('answered_briefly').notNull().default(false),
    talkTimeSeconds: numeric('talk_time_seconds', { precision: 10, scale: 0 }),
    durationSeconds: numeric('duration_seconds', { precision: 10, scale: 0 }),
    contactNumber: text('contact_number'),
    /** Ten digits, or null where the number could not be keyed. The join key. */
    contactKey: text('contact_key'),
    contactExternalId: text('contact_external_id'),
    agentName: text('agent_name'),
    /**
     * The lead this call was matched to, by phone number.
     *
     * Resolved in its own idempotent pass rather than at insert, because a call
     * can arrive before the lead is synced and a lead's phone can arrive after
     * the call. Null means unmatched, which is a coverage fact reported on
     * screen — never a reason to drop the call from a volume.
     */
    leadExternalId: text('lead_external_id'),
    source: callSourceEnum('source').notNull(),
    syncRunId: uuid('sync_run_id').references(() => syncRuns.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('calls_upsert_key').on(t.tenantId, t.externalId),
    index('calls_tenant_occurred_idx').on(t.tenantId, t.occurredAt),
    index('calls_tenant_occurred_on_idx').on(t.tenantId, t.occurredOn),
    index('calls_tenant_contact_idx').on(t.tenantId, t.contactKey),
    index('calls_tenant_lead_idx').on(t.tenantId, t.leadExternalId, t.direction),
    index('calls_tenant_outcome_idx').on(t.tenantId, t.outcome, t.occurredAt),
  ],
);
