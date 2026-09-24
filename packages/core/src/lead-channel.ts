/**
 * Which source a lead is credited to: a paid platform, organic search, or
 * nobody.
 *
 * A paid platform is proven by its click ID. Organic search has no click ID,
 * so it is proven by the absence of every paid signal *and* the presence of a
 * search engine's results page as the referrer. Both halves matter:
 *
 *   - **A search referrer alone is not organic.** A Google Ads click arrives
 *     from google.com too. In Spartan's org 95% of the leads a referrer field
 *     labels `google_organic` carry a gclid and `utm_medium=cpc`
 *     (24 September 2026), which is why that label is not used.
 *   - **No paid signal alone is not organic either.** Direct, referral, phone,
 *     email, lead vendors and outbound all have no click ID. They stay
 *     unattributed — "we cannot say" — rather than being guessed into a
 *     channel that then looks like it performs.
 *
 * The hosts and the mediums that count as unpaid are a config row
 * (`organic_search_evidence`); the test is here, so the ingest, the backfill
 * and the tests cannot disagree about it.
 */

/** The source key organic search is credited under, beside the platform keys. */
export const ORGANIC_SEARCH = 'organic_search';

export type OrganicSearchRule = {
  /**
   * Search-results hosts, `www.` stripped. `google.*` matches any Google
   * country domain (`google.com`, `google.co.uk`) and nothing under it, so
   * `mail.google.com` and `ads.google.com` are not search.
   */
  searchHosts: readonly string[];
  /** `utm_medium` values that do not mark a paid visit (`organic`). */
  unpaidMediums: readonly string[];
};

export type LeadSourceEvidence = {
  clickIdType: string | null;
  referrerUrl: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
};

/** The `organic_search_evidence` row, or null when absent or malformed. */
export function parseOrganicSearchRule(value: unknown): OrganicSearchRule | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const list = (x: unknown) =>
    Array.isArray(x) && x.every((s) => typeof s === 'string' && s.trim() !== '')
      ? (x as string[]).map((s) => s.trim().toLowerCase())
      : null;
  const searchHosts = list(v.searchHosts);
  const unpaidMediums = list(v.unpaidMediums ?? []);
  if (!searchHosts || searchHosts.length === 0 || !unpaidMediums) return null;
  return { searchHosts, unpaidMediums };
}

/** The host of an http(s) URL, `www.` stripped; null for anything else. */
function hostOf(url: string): string | null {
  const match = /^https?:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(url.trim());
  return match ? match[1]!.toLowerCase().replace(/^www\./, '') : null;
}

function matchesHost(host: string, pattern: string): boolean {
  if (!pattern.endsWith('.*')) return host === pattern;
  const stem = pattern.slice(0, -2);
  // `google.*`: `google.` then a TLD of one or two labels — `com`, `co.uk`.
  return host.startsWith(`${stem}.`) && /^[a-z]{2,}(\.[a-z]{2,})?$/.test(host.slice(stem.length + 1));
}

const blank = (s: string | null) => s === null || s.trim() === '';

/** Whether the lead is proven to have come from an unpaid search result. */
export function isOrganicSearch(lead: LeadSourceEvidence, rule: OrganicSearchRule): boolean {
  if (lead.clickIdType !== null) return false;
  if (!blank(lead.utmCampaign)) return false;
  if (!blank(lead.utmMedium) && !rule.unpaidMediums.includes(lead.utmMedium!.trim().toLowerCase())) {
    return false;
  }
  const host = lead.referrerUrl ? hostOf(lead.referrerUrl) : null;
  return host !== null && rule.searchHosts.some((p) => matchesHost(host, p));
}

/**
 * The lead's source: its click's platform, else organic search where the rule
 * proves it, else null. A tenant with no rule has no organic source at all.
 */
export function leadChannel(lead: LeadSourceEvidence, rule: OrganicSearchRule | null): string | null {
  if (lead.clickIdType !== null) return lead.clickIdType;
  return rule && isOrganicSearch(lead, rule) ? ORGANIC_SEARCH : null;
}

/**
 * Whether a source buys its traffic. Organic search has no spend, so it has
 * no cost per anything — an em dash with its reason, never $0.
 */
export function isPaidChannel(channel: string): boolean {
  return channel !== ORGANIC_SEARCH;
}

/** Why an unpaid source has no spend or cost per deal, as every screen says it. */
export const UNPAID_REASON =
  'Organic search is not paid for, so it has no spend and no cost per deal. ' +
  'Its leads came from an unpaid search result with no ad click.';
