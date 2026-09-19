/**
 * The rates an ad platform's own numbers support.
 *
 * Every one of these is arithmetic over two figures the platform reported — a
 * derived rate, never an invented metric. The rule they all share is the one
 * worth stating once: **an empty denominator has no rate.** Not zero, not
 * infinity, not a dash invented at the call site. `null`, so the caller has to
 * decide what an absence looks like, and `Not measured` is the answer
 * everywhere in this product.
 *
 * A day with spend and no impressions did not achieve a CPM of zero; there was
 * no auction to price. A campaign with clicks and no conversions has a
 * conversion rate of zero, because the denominator is real — that one is a
 * measurement and is returned as 0. The difference between "the denominator is
 * empty" and "the numerator is empty" is the whole of this module.
 */

/** Click-through rate: clicks over impressions. */
export function ctr(clicks: number, impressions: number): number | null {
  return impressions > 0 ? clicks / impressions : null;
}

/** Cost per click. */
export function cpc(spend: number, clicks: number): number | null {
  return clicks > 0 ? spend / clicks : null;
}

/** Cost per thousand impressions. */
export function cpm(spend: number, impressions: number): number | null {
  return impressions > 0 ? (spend / impressions) * 1000 : null;
}

/**
 * Conversion rate: conversions over clicks.
 *
 * Over *clicks*, not impressions, because that is what both platforms mean by
 * it. Zero conversions against real clicks is 0 — a measurement — while zero
 * clicks has no rate at all.
 */
export function conversionRate(conversions: number, clicks: number): number | null {
  return clicks > 0 ? conversions / clicks : null;
}

export function costPerConversion(spend: number, conversions: number): number | null {
  return conversions > 0 ? spend / conversions : null;
}

/**
 * Frequency: impressions per person reached.
 *
 * Meta reports this directly per row and it is also impressions ÷ reach. It is
 * computed here rather than stored because the stored version would only ever
 * be right for the exact range it was fetched for — and reach is not additive,
 * so neither is frequency.
 */
export function frequency(impressions: number, reach: number | null): number | null {
  if (reach === null || reach <= 0) return null;
  return impressions / reach;
}

/**
 * The share of a platform's clicks that went somewhere.
 *
 * Only meaningful where a platform separates the two. Google reports one click
 * figure, so `allClicks` is null there and so is this — an absence of the
 * distinction, not a rate of 100%.
 */
export function linkClickShare(linkClicks: number, allClicks: number | null): number | null {
  if (allClicks === null || allClicks <= 0) return null;
  return linkClicks / allClicks;
}
