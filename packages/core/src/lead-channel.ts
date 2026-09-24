/**
 * Which source a lead is credited to.
 *
 * The values are a config row (`lead_source_rules`); the order they apply in
 * is here, so the ingest, the backfill and the tests cannot disagree. First
 * match wins:
 *
 *   1. **A click ID** — the platform whose click it is (gclid, fbclid).
 *   2. **gbraid / wbraid** — Google Ads: Google's click ID for iOS traffic,
 *      sent where no gclid is.
 *   3. **A marker source** (`utm_source=100A00`) — the channel it marks. GA4
 *      shows those sessions landing from Google Ads links with no gclid
 *      (24 September 2026).
 *   4. **A Lead Source that names a channel** (`Meta Ads`) — that channel.
 *      Meta's own lead forms carry no fbclid.
 *   5. **A paid UTM** — a paid `utm_medium`, or a campaign on a known ad
 *      source — credited to the channel its `utm_source` names. A paid tag
 *      with an unknown source is paid but provably neither channel, and stays
 *      in Direct & other.
 *   6. **A lead vendor** — its own named source, `vendor:<Name>`.
 *   7. **SEO/Organic** — referred from the tenant's own website or a search
 *      results page, with no paid signal of any kind. A search referrer alone
 *      is not enough: a Google Ads click arrives from google.com too.
 *   8. Otherwise null: **Direct & other**. No referrer and no other evidence
 *      is not a guess at any channel.
 */

/** The source key SEO/Organic is credited under, beside the platform keys. */
export const ORGANIC_SEARCH = 'organic_search';

/** Lead vendors are credited under `vendor:<display name>`. */
export const VENDOR_PREFIX = 'vendor:';

export type LeadSourceRules = {
  /** `utm_source` values (lower case) naming each ad channel. */
  utmSources: Record<string, readonly string[]>;
  /** `utm_source` values that alone prove a channel: `{ google_ads: ['100a00'] }`. */
  markerSources: Record<string, readonly string[]>;
  /** `utm_medium` values that mark a paid visit. */
  paidMediums: readonly string[];
  /** `utm_medium` values that do not (`organic`). */
  unpaidMediums: readonly string[];
  /** Lead Source values naming a channel: `{ 'meta ads': 'meta' }`. */
  leadSourceChannels: Record<string, string>;
  /** Lead Source values that are lead vendors, to their display names. */
  vendors: Record<string, string>;
  /**
   * Hosts, `www.` stripped, that make a lead SEO/Organic when nothing paid is
   * present: search results pages and the tenant's own website. `google.*`
   * matches any Google country domain and nothing under it, so
   * `mail.google.com` and `ads.google.com` are not search.
   */
  organicHosts: readonly string[];
};

export type LeadSourceEvidence = {
  clickIdType: string | null;
  /** A gbraid or wbraid, if the lead carries one. */
  braid?: string | null;
  referrerUrl: string | null;
  utmSource?: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  leadSource?: string | null;
};

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const blank = (s: string | null | undefined) => lower(s) === '';

function stringList(x: unknown): string[] | null {
  return Array.isArray(x) && x.every((s) => typeof s === 'string' && s.trim() !== '')
    ? (x as string[]).map((s) => s.trim().toLowerCase())
    : null;
}

function listMap(x: unknown): Record<string, string[]> | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(x)) {
    const list = stringList(v);
    if (!list) return null;
    out[k] = list;
  }
  return out;
}

function stringMap(x: unknown): Record<string, string> | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(x)) {
    if (typeof v !== 'string' || v.trim() === '') return null;
    out[k.trim().toLowerCase()] = v.trim();
  }
  return out;
}

/** The `lead_source_rules` row, or null when absent or malformed. */
export function parseLeadSourceRules(value: unknown): LeadSourceRules | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const utmSources = listMap(v.utmSources ?? {});
  const markerSources = listMap(v.markerSources ?? {});
  const paidMediums = stringList(v.paidMediums ?? []);
  const unpaidMediums = stringList(v.unpaidMediums ?? []);
  const leadSourceChannels = stringMap(v.leadSourceChannels ?? {});
  const vendors = stringMap(v.vendors ?? {});
  const organicHosts = stringList(v.organicHosts ?? []);
  if (!utmSources || !markerSources || !paidMediums || !unpaidMediums || !leadSourceChannels || !vendors || !organicHosts) {
    return null;
  }
  return { utmSources, markerSources, paidMediums, unpaidMediums, leadSourceChannels, vendors, organicHosts };
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

const channelOf = (lists: Record<string, readonly string[]>, value: string) =>
  Object.entries(lists).find(([, values]) => values.includes(value))?.[0] ?? null;

/**
 * The lead's source, by the rules above. A tenant with no rules keeps only
 * rule 1: its click's platform, or nobody.
 */
export function leadChannel(lead: LeadSourceEvidence, rules: LeadSourceRules | null): string | null {
  if (lead.clickIdType !== null) return lead.clickIdType;
  if (!rules) return null;

  if (!blank(lead.braid) && 'google_ads' in rules.utmSources) return 'google_ads';

  const source = lower(lead.utmSource);
  const marked = source ? channelOf(rules.markerSources, source) : null;
  if (marked) return marked;

  const named = rules.leadSourceChannels[lower(lead.leadSource)];
  if (named) return named;

  const medium = lower(lead.utmMedium);
  const sourceChannel = source ? channelOf(rules.utmSources, source) : null;
  const paidTag =
    (medium !== '' && rules.paidMediums.includes(medium)) || (!blank(lead.utmCampaign) && sourceChannel !== null);
  if (paidTag) return sourceChannel;

  const vendor = rules.vendors[lower(lead.leadSource)];
  if (vendor) return `${VENDOR_PREFIX}${vendor}`;

  // Any tag still present is a sign of something placed — a campaign, or a
  // medium not declared unpaid. Neither is proof of organic.
  if (!blank(lead.utmCampaign)) return null;
  if (medium !== '' && !rules.unpaidMediums.includes(medium)) return null;

  const host = lead.referrerUrl ? hostOf(lead.referrerUrl) : null;
  return host && rules.organicHosts.some((p) => matchesHost(host, p)) ? ORGANIC_SEARCH : null;
}

/** Whether the source is a lead vendor. */
export function isVendorChannel(channel: string): boolean {
  return channel.startsWith(VENDOR_PREFIX);
}

/**
 * Whether the source's spend is ingested, so a cost per anything exists.
 * SEO/Organic buys nothing, and a lead vendor is paid outside the ad
 * platforms; neither has a spend figure, so their cost cells are an em dash
 * with the reason — never $0.
 */
export function isPaidChannel(channel: string): boolean {
  return channel !== ORGANIC_SEARCH && !isVendorChannel(channel);
}

/** Hover text for SEO/Organic, as every screen says it. */
export const ORGANIC_DESCRIPTION =
  'Leads that came through the Spartan website or from Google search, not from ads.';

/** Hover text for Direct & other. */
export const DIRECT_AND_OTHER_DESCRIPTION =
  'No ad click, no lead vendor and no website or search referrer: direct visits, referrals, phone and repeat business.';

/** What a source is, for its ⓘ; null for an ad platform, which names itself. */
export function sourceDescription(channel: string): string | null {
  if (channel === ORGANIC_SEARCH) return ORGANIC_DESCRIPTION;
  if (isVendorChannel(channel)) return 'Leads bought from this lead vendor.';
  return null;
}

/** Why a source has no spend or cost per deal. Two sentences at most. */
export function noSpendReason(channel: string): string {
  return isVendorChannel(channel)
    ? 'This lead vendor is paid outside the ad platforms, and that spend is not ingested. So there is no cost per deal to show.'
    : 'SEO/Organic is not paid for, so it has no spend and no cost per deal.';
}

/** The short note in place of a spend figure. */
export function noSpendNote(channel: string): string {
  return isVendorChannel(channel) ? 'spend not ingested' : 'not paid for';
}

/**
 * The order sources are listed in on every screen: ad channels, then
 * SEO/Organic, then the lead vendors. Ad channels first also keeps them on the
 * first chart colours whatever vendors a period happens to have.
 */
export function sourceRank(channel: string): number {
  return isPaidChannel(channel) ? 0 : channel === ORGANIC_SEARCH ? 1 : 2;
}
