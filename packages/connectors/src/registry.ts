import type { Connector } from './types';
import { googleAdsConnector } from './google-ads/connector';
import { metaConnector } from './meta/connector';

/**
 * Platform registry.
 *
 * Google Ads was the first entry, in phase 3. Meta followed on 19 September
 * 2026 — at campaign grain and read synchronously, which is why it arrived
 * before GA4 and Search Console rather than last as originally planned: the
 * submit-then-poll Insights job that made it look hardest is only needed at ad
 * grain over long windows, and this engagement needs neither.
 */
const registry = new Map<string, Connector>();

export function register(connector: Connector): void {
  registry.set(connector.key, connector);
}

// Phase 3. Registered here rather than at a call site so that `listConnectors`
// is the single answer to "what can this platform ingest", and a connector
// cannot be built and then quietly left unwired.
register(googleAdsConnector());
register(metaConnector());

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
  { key: 'meta', label: 'Meta Ads', phase: 3 },
  { key: 'call_tracking', label: 'Call tracking', phase: 7 },
] as const;
