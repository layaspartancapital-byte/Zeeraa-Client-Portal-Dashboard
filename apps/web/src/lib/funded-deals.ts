/**
 * The funded-deals list on the Google Ads and Meta pages (25 September 2026).
 *
 * Built from the same set of deals the page counts — `platformOutcomes` hands
 * over exactly the opportunities it credited to this platform — so the list
 * has one row per counted deal and cannot disagree with the figure above it.
 *
 * Every cell is either what a source recorded or null, which the page renders
 * as "Not recorded". Nothing is inferred:
 *
 * - The campaign is the one attribution credits, as the page's "By campaign"
 *   card reads it. Where it credits none — a Meta deal never has one (no click
 *   lookup), and a Google click older than `click_view`'s window may not — the
 *   list falls back to the deal's own lead's `utm_campaign`, under the same
 *   rule as the keyword below, and marks the cell as coming from the URL tag
 *   (`campaignFromTag`). A tag that is exactly an ingested campaign's id on
 *   this platform is shown by that campaign's name; any other tag is shown as
 *   the lead recorded it, never matched by prefix or likeness. "By campaign"
 *   and the count do not use the fallback.
 * - The keyword or ad is the deal's own lead's landing-URL parameter, named by
 *   the `landing_url_parameters` row, and only where that lead's source
 *   (`leads.channel`, decided at ingest) is this platform — a lead that came
 *   from somewhere else says nothing about this platform's keyword.
 * - A Meta ad is named where the sync has read its name; otherwise its id,
 *   which is what the lead recorded.
 */

export type FundedDeal = {
  opportunityId: string;
  name: string | null;
  /** The tenant-local day the deal reached the value stage in this range. */
  fundedOn: string;
  fundedAmount: number | null;
  campaign: string | null;
  /** True where `campaign` is the lead's URL tag rather than attribution's. */
  campaignFromTag: boolean;
  /** The keyword (Google Ads) or ad (Meta), or null. */
  detail: string | null;
};

export type FundedDealInputs = {
  platform: string;
  /** The deals the page counts for this platform. */
  credited: ReadonlySet<string>;
  /** Value-stage events in range, one or more per deal. */
  events: readonly { opportunityId: string; occurredOn: string }[];
  /** The credited campaign's name per deal, where attribution resolved one. */
  campaigns: ReadonlyMap<string, string | null>;
  opportunities: ReadonlyMap<string, { name: string | null; fundedAmount: number | null }>;
  /** Leads converted into these deals. */
  leads: readonly {
    opportunityId: string;
    channel: string | null;
    createdAt: Date;
    detail: string | null;
    /** The lead's `utm_campaign`, verbatim. */
    campaignTag: string | null;
  }[];
  /** This platform's ingested campaigns, name by the platform's own id. */
  campaignNamesById?: ReadonlyMap<string, string>;
  /** Ad names by id, for a platform whose detail is an id. */
  adNames?: ReadonlyMap<string, string>;
};

export function assembleFundedDeals(input: FundedDealInputs): FundedDeal[] {
  const firstFunded = new Map<string, string>();
  for (const e of input.events) {
    if (!input.credited.has(e.opportunityId)) continue;
    const seen = firstFunded.get(e.opportunityId);
    // A stage can recur; the deal is counted once, on its first funding here.
    if (!seen || e.occurredOn < seen) firstFunded.set(e.opportunityId, e.occurredOn);
  }

  // The deal's own lead from this platform — the earliest, if it has several.
  const lead = new Map<string, { createdAt: Date; detail: string | null; campaignTag: string | null }>();
  for (const l of input.leads) {
    if (l.channel !== input.platform || !input.credited.has(l.opportunityId)) continue;
    const seen = lead.get(l.opportunityId);
    if (!seen || l.createdAt < seen.createdAt) lead.set(l.opportunityId, l);
  }

  return [...input.credited]
    .map((id) => {
      const opp = input.opportunities.get(id);
      const own = lead.get(id);
      const raw = own?.detail?.trim() || null;
      const credited = input.campaigns.get(id) ?? null;
      const tag = own?.campaignTag?.trim() || null;
      const fromTag = credited === null && tag !== null;
      return {
        opportunityId: id,
        name: opp?.name?.trim() || null,
        fundedOn: firstFunded.get(id) ?? '',
        fundedAmount: opp?.fundedAmount ?? null,
        campaign: fromTag ? (input.campaignNamesById?.get(tag!) ?? tag) : credited,
        campaignFromTag: fromTag,
        detail: raw && input.adNames ? (input.adNames.get(raw) ?? raw) : raw,
      };
    })
    .sort((a, b) => b.fundedOn.localeCompare(a.fundedOn) || (a.name ?? '').localeCompare(b.name ?? ''));
}
