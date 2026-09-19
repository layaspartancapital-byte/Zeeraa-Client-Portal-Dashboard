export * from './types';
export * from './registry';
export * from './salesforce/jwt';
export * from './salesforce/client';
export * from './salesforce/probe';
export * from './salesforce/stage-history';
export * from './salesforce/qualification-bands';
export * from './salesforce/submissions';
export * from './salesforce/mapping';
export * from './salesforce/sync';
export * from './salesforce/inventory';
export * from './salesforce/exclusion';
export * from './google-ads/index';
/*
 * Meta is re-exported by name rather than with `export *`.
 *
 * Six of its exports collide with Google Ads' — both platforms have an account
 * normaliser, a campaign normaliser, a daily-metrics normaliser and a reporting
 * zone check, because both have the same problems. Inside `meta/` the plain
 * names are right; at the package boundary they have to say which platform they
 * belong to, or a call site picks one by accident and normalises Meta rows with
 * Google's field names, which yields zeroes rather than an error.
 */
export {
  metaConnector,
  MetaClient,
  MetaApiError,
  DEFAULT_CONVERSION_ACTION_TYPES,
  conversionsFrom,
  accountStatusDetail,
  DEFAULT_API_VERSION as META_DEFAULT_API_VERSION,
  checkReportingZone as checkMetaReportingZone,
  normalizeAccount as normalizeMetaAccount,
  normalizeCampaigns as normalizeMetaCampaigns,
  normalizeDailyMetrics as normalizeMetaDailyMetrics,
} from './meta/index';
export type {
  MetaCredentials,
  MetaConfig,
  MetaAccount,
  MetaAction,
  MetaInsightRow,
  MetaCampaignRow,
  MetaAccountRow,
  MetaPage,
  ReportingZone as MetaReportingZone,
} from './meta/index';
export * from './google-organic/index';
export * from './aloware/csv';
export * from './aloware/calls';
