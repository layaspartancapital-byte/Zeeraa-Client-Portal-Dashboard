/**
 * Platforms a tenant is being connected to, shown on the rail as
 * "Integrating" until they report (25 September 2026).
 *
 * Which platforms is a judgement about one engagement, so it is the
 * `integrating_platforms` config row. What a platform will show once
 * connected is a fact about the platform, so it is here. A platform leaves
 * the list the moment it is a reporting platform — a connection that has
 * reported data — and its rail item becomes the ordinary page, with no edit.
 */
export const INTEGRATION_PREVIEWS: Record<string, string> = {
  linkedin_ads: 'Spend, clicks and the leads and funded deals LinkedIn campaigns bring in.',
  microsoft_ads: 'Spend, clicks and the leads and funded deals Microsoft Ads campaigns bring in.',
  semrush: 'Keyword rankings and search visibility for the website, tracked over time.',
};

/** The row's value, or an empty list for a missing or malformed one. */
export function parseIntegratingPlatforms(value: unknown): string[] {
  const list = (value as { platforms?: unknown } | null | undefined)?.platforms;
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((k): k is string => typeof k === 'string' && k.length > 0))];
}

/** Configured platforms that are not reporting yet, in the configured order. */
export function stillIntegrating(configured: readonly string[], reporting: readonly string[]): string[] {
  const live = new Set(reporting);
  return configured.filter((key) => !live.has(key));
}
