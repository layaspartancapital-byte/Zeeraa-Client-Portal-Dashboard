/**
 * The display name for a connector key.
 *
 * In core rather than the web app because a reason stored by a job — a frozen
 * baseline's "Google Ads spend was not read for 19–20 Sep" — has to name the
 * channel exactly as the screen does, and the job cannot import the screen.
 */
export const PLATFORM_LABELS: Record<string, string> = {
  salesforce: 'Salesforce',
  google_ads: 'Google Ads',
  microsoft_ads: 'Microsoft Ads',
  meta: 'Meta Ads',
  linkedin_ads: 'LinkedIn Ads',
  ga4: 'GA4',
  search_console: 'Search Console',
  semrush: 'Semrush',
  call_tracking: 'Call tracking',
  // A source, not a connector (`leadChannel`): the tenant's website or a search
  // result, with no ad behind it.
  organic_search: 'SEO/Organic',
};

export function platformLabel(platform: string): string {
  // A lead vendor carries its display name in its key: `vendor:Popcrumbs`.
  if (platform.startsWith('vendor:')) return platform.slice('vendor:'.length);
  return PLATFORM_LABELS[platform] ?? platform;
}
