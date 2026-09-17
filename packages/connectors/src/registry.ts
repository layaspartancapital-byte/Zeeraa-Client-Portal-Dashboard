import type { Connector } from './types';
import { googleAdsConnector } from './google-ads/connector';

/**
 * Platform registry.
 *
 * Google Ads is the first entry, in phase 3. GA4 and Search Console come in
 * phase 7 because they are the lowest-risk way to prove the rest of the
 * pipeline end to end; Meta comes last because its submit-then-poll Insights
 * jobs are the hardest.
 */
const registry = new Map<string, Connector>();

export function register(connector: Connector): void {
  registry.set(connector.key, connector);
}

// Phase 3. Registered here rather than at a call site so that `listConnectors`
// is the single answer to "what can this platform ingest", and a connector
// cannot be built and then quietly left unwired.
register(googleAdsConnector());

export function getConnector(key: string): Connector | undefined {
  return registry.get(key);
}

export function listConnectors(): Connector[] {
  return [...registry.values()];
}

/** Platforms the product intends to support, whether or not they are built. */
export const PLANNED_PLATFORMS = [
  { key: 'salesforce', label: 'Salesforce', phase: 2 },
  { key: 'google_ads', label: 'Google Ads', phase: 3 },
  { key: 'ga4', label: 'GA4', phase: 7 },
  { key: 'search_console', label: 'Search Console', phase: 7 },
  { key: 'microsoft_ads', label: 'Microsoft Ads', phase: 7 },
  { key: 'linkedin_ads', label: 'LinkedIn Ads', phase: 7 },
  { key: 'semrush', label: 'Semrush', phase: 7 },
  { key: 'meta', label: 'Meta', phase: 7 },
  { key: 'call_tracking', label: 'Call tracking', phase: 7 },
] as const;
