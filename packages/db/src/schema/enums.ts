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
]);

export const organicSourceEnum = pgEnum('organic_source', ['gsc', 'ga4', 'semrush']);

export const attributionModelEnum = pgEnum('attribution_model', ['first_touch', 'last_touch']);

export const improvementDirectionEnum = pgEnum('improvement_direction', ['up', 'down']);

export const commitmentPeriodEnum = pgEnum('commitment_period', ['monthly', 'quarterly']);

export const deliverableSourceEnum = pgEnum('deliverable_source', [
  'manual',
  'derived_from_assets',
]);

export const slaEventTypeEnum = pgEnum('sla_event_type', [
  'slack_response',
  'daily_update',
  'weekly_call',
  'monthly_report',
  'qbr',
]);

export const assetStatusEnum = pgEnum('asset_status', [
  'draft',
  'submitted',
  'in_review',
  'changes_requested',
  'approved',
  'published',
]);

export const mentionSourceEnum = pgEnum('mention_source', ['asset', 'comment']);

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

export const stageOriginEnum = pgEnum('stage_origin', ['observed', 'computed']);

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
