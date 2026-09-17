import type { Connector } from './types';

/**
 * Platform registry.
 *
 * Empty by design in phase 1: the interface exists and the sync machinery can
 * be written against it, but no connector is implemented yet. GA4 and Search
 * Console come first in phase 7 because they are the lowest-risk way to prove
 * the pipeline end to end; Meta comes last because its submit-then-poll
 * Insights jobs are the hardest.
 */
const registry = new Map<string, Connector>();

export function register(connector: Connector): void {
  registry.set(connector.key, connector);
}

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
