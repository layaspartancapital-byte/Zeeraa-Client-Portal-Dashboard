/**
 * GA4 and Search Console share an OAuth client, a refresh token and a person's
 * consent with Google Ads, so they share a module.
 *
 * What they do not share is a grain: GA4 counts sessions, Search Console counts
 * appearances in a results page. Neither can name a person, so neither ever
 * reaches the attribution join.
 */

export const GA4_API = 'https://analyticsdata.googleapis.com/v1beta';
export const SEARCH_CONSOLE_API = 'https://www.googleapis.com/webmasters/v3';

/** The scopes each API needs, for the error message when one is absent. */
export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
export const SEARCH_CONSOLE_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

export type GoogleOrganicCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

export type Ga4Config = {
  /** Numeric property id, without the `properties/` prefix. */
  propertyId: string;
  /** How many rows of each breakdown to keep per day. */
  breakdownLimit?: number;
};

export type SearchConsoleConfig = {
  /**
   * Exactly as Search Console spells it, trailing slash and all — or the
   * `sc-domain:example.com` form for a domain property. A URL-prefix property
   * and a domain property are different properties with different data, and a
   * near-miss here returns a 403 that reads like a permissions problem.
   */
  siteUrl: string;
  breakdownLimit?: number;
};

/** One row of a GA4 report, already flattened out of the API's column shape. */
export type Ga4Row = {
  date: string;
  dimension: 'total' | 'landing_page' | 'source_medium';
  dimensionValue: string;
  sessions: number;
  engagedSessions: number;
  users: number;
};

export type SearchConsoleRow = {
  date: string;
  dimension: 'total' | 'query' | 'page';
  dimensionValue: string;
  clicks: number;
  impressions: number;
  /** As reported. Impression-weighted when aggregated, never averaged plainly. */
  position: number | null;
};
