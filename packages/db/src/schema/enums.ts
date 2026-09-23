import { pgEnum } from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', [
  'zeeraa_admin',
  'zeeraa_member',
  'client_admin',
  'client_viewer',
]);

export const connectionStatusEnum = pgEnum('connection_status', [
  'not_configured',
  'healthy',
  'degraded',
  'failing',
  /**
   * A designed state, not an error (§9.5). The dependency sits outside Zeeraa's
   * control — a Salesforce field that does not exist yet, click-ID capture not
   * yet live on the site.
   */
  'waiting_on_client',
]);

export const syncStatusEnum = pgEnum('sync_status', [
  'running',
  'succeeded',
  'partial',
  'failed',
  'dead_lettered',
  /** The runner did not reach this platform in its budget (migration 0030). */
  'skipped',
]);

export const organicSourceEnum = pgEnum('organic_source', ['gsc', 'ga4', 'semrush']);

export const attributionModelEnum = pgEnum('attribution_model', ['first_touch', 'last_touch']);

export const improvementDirectionEnum = pgEnum('improvement_direction', ['up', 'down']);

export const notificationChannelPrefEnum = pgEnum('notification_channel_pref', [
  'instant',
  'digest',
  'off',
]);

export const dataSourceKindEnum = pgEnum('data_source_kind', [
  'api',
  'manual',
  'derived_from_assets',
]);

export const stageOriginEnum = pgEnum('stage_origin', ['observed', 'computed', 'corrected']);

/**
 * The state of one day of click ingestion.
 *
 * `expired` is not a kind of failure and must not be retried: `click_view`
 * serves only the last 90 days, so a day past that edge is a hole in the record
 * rather than a job that went wrong. Conflating the two would leave the
 * backfill retrying impossible requests every night and would hide the hole.
 */
export const clickIngestStatusEnum = pgEnum('click_ingest_status', [
  'pending',
  'succeeded',
  'failed',
  'expired',
]);

export const clickIdSourceEnum = pgEnum('click_id_source', [
  /** Read from the mapped field on Opportunity. */
  'opportunity_field',
  /** Recovered through Lead.ConvertedOpportunityId by the backfill. */
  'lead_conversion',
]);

/**
 * The outcome of evaluating a tenant's qualification bar against one lead.
 *
 * Three states, not two. `undeterminable` is the one that matters: the answers
 * arrive as bands (`< $15,000`, `0 - 1 Years`) and a band that contains the
 * threshold cannot be resolved either way. Folding those into `unqualified`
 * would understate the MQL rate by however many forms answered in a straddling
 * band — 4.3% of the population that has both inputs at all, plus every lead
 * whose only time-in-business field is one nobody can decode.
 */
export const mqlVerdictEnum = pgEnum('mql_verdict', [
  'qualified',
  'unqualified',
  'undeterminable',
]);

/**
 * What one lender did with one submission.
 *
 * Three states, and `undecided` is load-bearing. A deal goes to several lenders
 * at once and most submissions are still open or never completed — 706 of
 * Spartan's 1,427 — so folding them into a denominator would report a lender
 * as declining a deal it has not answered on. Only `offered` and `declined`
 * are decisions, and only decisions belong in a rate.
 *
 * The raw picklist value is stored alongside this, because the mapping from a
 * client's status vocabulary onto these three is configuration and will be
 * refined; keeping the original means a refinement is a query rather than a
 * re-ingest.
 */
export const submissionOutcomeEnum = pgEnum('submission_outcome', [
  'offered',
  'declined',
  'undecided',
]);

/**
 * What happened on one call.
 *
 * `abandoned` is the one that must not be folded away: the caller ended it
 * before anybody answered, so it is neither a conversation nor an agent's
 * attempt at one — 2,002 of Spartan's 28,863 calls. Putting it in either of
 * the others inflates that one, and putting it in the denominator of a connect
 * rate measures the client's marketing rather than the desk.
 *
 * `connected` requires talk time past a configured threshold, not merely the
 * vendor's `completed`: 26,311 calls are `completed` and 13,376 of those
 * talked for under ten seconds. Answering machines are not conversations.
 */
export const callOutcomeEnum = pgEnum('call_outcome', ['connected', 'attempted', 'abandoned']);

export const callDirectionEnum = pgEnum('call_direction', ['inbound', 'outbound', 'unknown']);

/** How a call reached us: the historical export, or the live webhook. */
export const callSourceEnum = pgEnum('call_source', ['csv_import', 'webhook']);
