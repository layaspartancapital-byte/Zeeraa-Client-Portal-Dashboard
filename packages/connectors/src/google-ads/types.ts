/**
 * Google Ads, phase 3.
 *
 * Two things this connector reads, for two different jobs:
 *
 *   - Campaign-level daily spend, into `daily_metrics`. Batched by date range,
 *     re-pulled on a trailing 90-day window and upserted, exactly as §6 and §7
 *     require.
 *   - Click-level `gclid` rows, into `ad_clicks`. These are what make the
 *     spend-to-funded join possible at all, and they follow neither rule: one
 *     day per query, and a rolling 90-day lookback after which the data is
 *     gone. See docs/brief-amendments.md, "§6 and §7 — `click_view`".
 *
 * Everything here is per tenant. Spartan hands us access to their own manager
 * account rather than sitting under a Zeeraa MCC, so the manager account, the
 * OAuth consent and the Cloud project all belong to the client. Another client
 * may do the reverse. Nothing about this connector assumes one agency-level
 * account covers every tenant — the whole credential set is a connection row.
 */

/**
 * Per-tenant secrets. Encrypted at rest in `connections.credentials_encrypted`.
 *
 * The OAuth client belongs to a Google Cloud project, and since 9 September
 * 2026 that project — not a developer token — is what carries the API access
 * level. So these four fields are not merely a login: `clientId` transitively
 * determines what the connection is allowed to query.
 */
export type GoogleAdsCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /**
   * Optional, and ignored by Google's servers since the developer-token sunset
   * on 9 September 2026. Kept in the type for two reasons: a connection
   * configured before that date still holds one, and an org on an older
   * integration path may still be issued one. The client sends it when present
   * purely so nothing breaks if Google's rollback ever needs it; it is not
   * required and its absence is not a misconfiguration.
   *
   * Do not read an access level from it. The API Center still displays a level
   * against the old token and that display is explicitly documented as
   * possibly inaccurate.
   */
  developerToken?: string;
};

/** Non-secret connection settings, in `connections.config`. */
export type GoogleAdsConfig = {
  /** The account being reported on. Ten digits, no dashes. */
  customerId: string;
  /**
   * The manager account the request is made through. Ten digits, no dashes.
   * Required when the OAuth user reaches the account through a manager, which
   * is Spartan's arrangement; omitted when the account is queried directly.
   */
  loginCustomerId?: string;
  /**
   * Google sunsets API versions roughly quarterly, so this is configuration
   * rather than a constant — a version bump must never be a code change on a
   * deadline.
   */
  apiVersion?: string;
  /**
   * The ad account's own reporting timezone, e.g. 'America/New_York'. Learned
   * from the API and stored, so the day-boundary check below can run without a
   * round trip.
   */
  accountTimezone?: string;
};

/**
 * v23, v24 and v25 are the supported versions as of September 2026; v25 is the
 * newest. Overridden per connection — see `apiVersion`.
 */
export const DEFAULT_API_VERSION = 'v25';

/** Google reports money in millionths of the account currency unit. */
export const MICROS_PER_UNIT = 1_000_000;

/**
 * How far back `click_view` serves data. Rolling, not anchored: a click that
 * falls out of this window is unrecoverable, which is why the backfill is
 * urgent rather than merely pending.
 */
export const CLICK_VIEW_LOOKBACK_DAYS = 90;

/**
 * Daily operation limits, by the access level of the Cloud project behind the
 * OAuth client. Here to make an error message useful, not to enforce anything.
 *
 * `Explorer` is the one to watch: 2,880 operations a day against production
 * accounts is below what a 90-day click backfill needs in one run, so a project
 * at that level finishes the backfill over several nights rather than failing
 * outright — which is exactly the case the resumable day ledger handles.
 */
export const ACCESS_LEVEL_DAILY_OPERATIONS = {
  test: 15_000,
  explorer: 2_880,
  basic: 15_000,
  standard: Number.POSITIVE_INFINITY,
} as const;

export type AccessLevel = keyof typeof ACCESS_LEVEL_DAILY_OPERATIONS;

/** One row of a GAQL response, as the REST API shapes it. */
export type GoogleAdsRow = {
  campaign?: { id?: string; name?: string; status?: string; advertisingChannelType?: string };
  adGroup?: { id?: string; name?: string };
  customer?: {
    id?: string;
    descriptiveName?: string;
    currencyCode?: string;
    timeZone?: string;
  };
  clickView?: { gclid?: string };
  segments?: { date?: string; adNetworkType?: string; device?: string };
  metrics?: {
    impressions?: string | number;
    clicks?: string | number;
    costMicros?: string | number;
    conversions?: string | number;
  };
};

/** A click Google charged for, and the campaign it belonged to. */
export type AdClickRow = {
  clickId: string;
  /** The ad account's local calendar day, as Google reported it. */
  reportedDate: string;
  externalCampaignId: string | null;
  externalAdGroupId: string | null;
  adNetworkType: string | null;
  device: string | null;
};

export type GoogleAdsAccount = {
  externalAccountId: string;
  name: string;
  currency: string | null;
  timeZone: string | null;
};

/**
 * The Cloud project number an OAuth client belongs to.
 *
 * Since the developer-token sunset the access level is a property of that
 * project, and nothing in an API response names it — so when a call is refused
 * for access-level reasons, this is the only way to tell somebody *which*
 * project to go and look at. Client IDs are formatted
 * `<project-number>-<hash>.apps.googleusercontent.com`.
 *
 * Returns null rather than throwing on an unfamiliar shape: this is diagnostic
 * sugar, and a format change at Google must not take a sync down with it.
 */
export function cloudProjectNumber(clientId: string): string | null {
  const match = /^(\d+)-[^.]+\.apps\.googleusercontent\.com$/.exec(clientId.trim());
  return match?.[1] ?? null;
}
