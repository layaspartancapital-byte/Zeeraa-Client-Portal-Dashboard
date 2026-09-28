/**
 * LinkedIn Ads (Advertising API, Development tier), read-only: `r_ads` and
 * `r_ads_reporting`.
 *
 * The app's client id and secret are Zeeraa's (`LINKEDIN_CLIENT_ID`,
 * `LINKEDIN_CLIENT_SECRET`), like the Semrush key. What belongs to a tenant is
 * the member's grant — the tokens below, encrypted on the connection row by
 * the Connect flow — and the ad account id in the connection config.
 */

/** Marketing API version, `YYYYMM`. 202510 is sunset on 15 October 2026. */
export const LINKEDIN_API_VERSION = '202609';

export const LINKEDIN_SCOPES = ['r_ads', 'r_ads_reporting'] as const;

export type LinkedInCredentials = {
  accessToken: string;
  /** ISO instant. Access tokens live 60 days. */
  accessTokenExpiresAt: string;
  refreshToken: string | null;
  /**
   * ISO instant. Refresh tokens live 365 days from the original grant, and a
   * refresh does not extend them — the member re-authorises once a year.
   */
  refreshTokenExpiresAt: string | null;
  scope: string;
  /** Who pressed Connect, and when. */
  authorizedBy: string;
  authorizedAt: string;
};

export type LinkedInConfig = {
  /** Digits only, e.g. 509908440. */
  adAccountId: string;
  apiVersion?: string;
  /**
   * `landingPageClicks` (clicks to the landing page, like Meta's link clicks)
   * or `clicks` (every chargeable click). The other is kept as all clicks.
   */
  clickMetric?: 'landingPageClicks' | 'clicks';
  /**
   * Which LinkedIn counts make a conversion. Website conversions and Lead Gen
   * Form leads are separate actions, so summing them does not double count.
   */
  conversionMetrics?: LinkedInConversionMetric[];
  /** When the grant's refresh token expires; not secret, so the page can say so. */
  refreshTokenExpiresAt?: string | null;
};

export type LinkedInConversionMetric = 'externalWebsiteConversions' | 'oneClickLeads';

export const DEFAULT_CONVERSION_METRICS: LinkedInConversionMetric[] = [
  'externalWebsiteConversions',
  'oneClickLeads',
];

export type LinkedInDate = { year: number; month: number; day: number };

export type LinkedInAnalyticsRow = {
  dateRange?: { start?: LinkedInDate; end?: LinkedInDate };
  pivotValues?: string[];
  impressions?: number;
  clicks?: number;
  landingPageClicks?: number;
  /** A decimal string in the account's currency. */
  costInLocalCurrency?: string;
  externalWebsiteConversions?: number;
  oneClickLeads?: number;
};

export type LinkedInAccountRow = {
  id?: number;
  name?: string;
  currency?: string;
  status?: string;
  type?: string;
};

export type LinkedInCampaignRow = {
  id?: number;
  name?: string;
  status?: string;
  type?: string;
  objectiveType?: string;
};

export type LinkedInTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
};
