/**
 * Each platform's own vocabulary, kept in each platform's own map.
 *
 * `campaigns.campaign_type` stores what the platform said, verbatim. These maps
 * turn that into something a reader recognises — and they are deliberately
 * separate, because `SEARCH` and `OUTCOME_LEADS` answer different questions.
 * There is no shared taxonomy here and nothing groups a Google type with a Meta
 * objective; a value with no entry renders as the platform's own string rather
 * than being bucketed into "Other", which would hide a campaign kind nobody had
 * noticed appearing.
 */

/** Google Ads `advertising_channel_type`. */
export const GOOGLE_CHANNEL_TYPES: Record<string, string> = {
  SEARCH: 'Search',
  DISPLAY: 'Display',
  VIDEO: 'Video / YouTube',
  SHOPPING: 'Shopping',
  PERFORMANCE_MAX: 'Performance Max',
  DEMAND_GEN: 'Demand Gen',
  DISCOVERY: 'Discovery',
  MULTI_CHANNEL: 'App',
  LOCAL: 'Local',
  SMART: 'Smart',
  LOCAL_SERVICES: 'Local Services',
  TRAVEL: 'Travel',
  UNKNOWN: 'Unknown',
  UNSPECIFIED: 'Unspecified',
};

/** Meta campaign `objective`. */
export const META_OBJECTIVES: Record<string, string> = {
  OUTCOME_LEADS: 'Leads',
  OUTCOME_SALES: 'Sales',
  OUTCOME_TRAFFIC: 'Traffic',
  OUTCOME_ENGAGEMENT: 'Engagement',
  OUTCOME_AWARENESS: 'Awareness',
  OUTCOME_APP_PROMOTION: 'App promotion',
  LINK_CLICKS: 'Link clicks',
  CONVERSIONS: 'Conversions',
  LEAD_GENERATION: 'Lead generation',
  BRAND_AWARENESS: 'Brand awareness',
  REACH: 'Reach',
  POST_ENGAGEMENT: 'Post engagement',
  VIDEO_VIEWS: 'Video views',
};

export type PlatformVocabulary = {
  /** What this platform calls the way it classifies a campaign. */
  typeColumnLabel: string;
  labels: Record<string, string>;
};

export const VOCABULARY: Record<string, PlatformVocabulary> = {
  google_ads: { typeColumnLabel: 'Campaign type', labels: GOOGLE_CHANNEL_TYPES },
  meta: { typeColumnLabel: 'Objective', labels: META_OBJECTIVES },
};

export function campaignTypeLabel(platform: string, key: string | null): string {
  if (key === null) return 'Account level — no campaign reported';
  return VOCABULARY[platform]?.labels[key] ?? key;
}
