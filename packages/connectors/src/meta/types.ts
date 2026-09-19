/** Graph API version. Pinned: Meta deprecates versions on a schedule. */
export const DEFAULT_API_VERSION = 'v23.0';

/**
 * A system user access token.
 *
 * Long-lived rather than literally permanent — it survives until somebody
 * revokes it, removes the system user from the business, or changes the app's
 * permissions. That is a client-side action, so the connector reports it as
 * `waiting_on_client` rather than as a failure of ours.
 */
export type MetaCredentials = {
  accessToken: string;
};

export type MetaConfig = {
  /** Digits only. `act_` is added where the API wants it. */
  adAccountId: string;
  apiVersion?: string;
  /**
   * Which `actions` entries count as a conversion.
   *
   * Configuration, not code, because the answer is a property of the client's
   * pixel and campaign objectives rather than of Meta. It defaults to `lead`,
   * and the default is load-bearing: Meta's `actions` array **overlaps itself**.
   * Over Spartan's trailing 90 days `lead` is 1,756, which is exactly
   * `onsite_web_lead` (921) plus `onsite_conversion.lead_grouped` (835). Listing
   * the components alongside the rollup would report 3,512 conversions against
   * 1,756 real ones, and nothing in the response marks which types nest.
   */
  conversionActionTypes?: string[];
  /**
   * Which Meta click figure fills the `clicks` column.
   *
   * `inline_link_clicks` by default, not `clicks`. Meta's `clicks` counts every
   * click on the ad — reactions, comments, profile taps — while Google Ads'
   * `clicks` counts clicks that go somewhere. Over the same 90 days the two are
   * 8,074 and 5,135: a 36% gap that would make one channel's click-through rate
   * mean something different from the other's on the same table.
   */
  clickMetric?: 'inline_link_clicks' | 'clicks';
};

export type MetaAccount = {
  externalAccountId: string;
  name: string;
  currency: string | null;
  timeZone: string | null;
  /** 1 is active. Anything else stops delivery and is worth saying out loud. */
  accountStatus: number | null;
};

export type MetaAction = { action_type: string; value: string };

export type MetaInsightRow = {
  campaign_id?: string;
  campaign_name?: string;
  date_start?: string;
  date_stop?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  inline_link_clicks?: string;
  reach?: string;
  frequency?: string;
  actions?: MetaAction[];
  account_currency?: string;
};

export type MetaCampaignRow = {
  id?: string;
  name?: string;
  status?: string;
  effective_status?: string;
  objective?: string;
};

export type MetaAccountRow = {
  id?: string;
  name?: string;
  currency?: string;
  timezone_name?: string;
  account_status?: number;
};
