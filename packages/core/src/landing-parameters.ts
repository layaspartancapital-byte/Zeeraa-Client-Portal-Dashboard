/**
 * Which landing-URL parameter on a lead carries which ad detail (the
 * `landing_url_parameters` config row, 25 September 2026).
 *
 * A tracking template is configured per ad account, so which UTM holds the
 * keyword or the ad is a fact about one engagement and lives in config. What
 * a detail is called, and which platforms have one, is here. A missing or
 * malformed row yields nothing, and every cell it would have filled reads
 * "Not recorded" — a parameter is never assumed.
 */

/** The detail each platform's funded-deals list names beside the campaign. */
export const AD_DETAIL: Record<string, { field: 'keyword' | 'ad'; label: string }> = {
  google_ads: { field: 'keyword', label: 'Keyword' },
  meta: { field: 'ad', label: 'Ad' },
};

export const LANDING_PARAMETERS = ['utm_term', 'utm_content', 'utm_campaign'] as const;
export type LandingParameter = (typeof LANDING_PARAMETERS)[number];

/** The configured parameter for this platform's detail, or null. */
export function landingParameterFor(value: unknown, platform: string): LandingParameter | null {
  const detail = AD_DETAIL[platform];
  if (!detail || !value || typeof value !== 'object') return null;
  const entry = (value as Record<string, unknown>)[platform];
  if (!entry || typeof entry !== 'object') return null;
  const param = (entry as Record<string, unknown>)[detail.field];
  return (LANDING_PARAMETERS as readonly unknown[]).includes(param) ? (param as LandingParameter) : null;
}
