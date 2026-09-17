/**
 * Attribution: which paid click gets the credit for a funded deal, and what
 * that deal therefore cost.
 *
 * Kept here rather than in the connector because the same word has to mean the
 * same thing on every screen (§8). "Cost per funded deal" is the north star
 * metric and it is not a division anybody may perform inline.
 *
 * Nothing here touches a database or a platform API. The inputs are touches and
 * spend; the outputs are a choice and a rate. That makes every rule in this
 * file testable against a table of cases rather than against an ad account.
 */

export type AttributionModel = 'first_touch' | 'last_touch';

/** One observed click belonging to an opportunity. */
export type AttributionTouch = {
  clickId: string;
  platform: string;
  /** Null when the click is known but its campaign is not — see below. */
  campaignId: string | null;
  /**
   * When the click happened, as the ad account reported it. Day precision is
   * all `click_view` gives, which is enough to order touches but not to break a
   * same-day tie — see `resolveAttribution`.
   */
  occurredOn: string;
};

export type AttributionChoice = {
  model: AttributionModel;
  touch: AttributionTouch | null;
  /**
   * Why there is no touch, when there is none. An unattributed deal is a fact
   * to report, not an absence to skip over, and the reasons are not equivalent:
   * a deal with no click never came from paid, while a deal whose click has
   * aged out of the platform's window came from paid and can no longer be
   * proven to.
   */
  unattributedReason?: 'no_touches' | 'no_campaign_resolved';
};

/**
 * Picks the touch that gets the credit.
 *
 * Ordering is by the day the click happened, then by click id. The tiebreak is
 * not cosmetic: `click_view` reports a date and no time, so two clicks on the
 * same day are genuinely unordered, and without a deterministic rule the same
 * data would attribute differently on each run depending on row order. Sorting
 * by click id is arbitrary but stable, which is the property that matters —
 * a metric that changes when nothing changed is worse than one that is
 * arbitrary in a documented way.
 *
 * Touches whose campaign could not be resolved are kept in the ordering rather
 * than dropped. Dropping them would silently promote an earlier or later click
 * into a position it did not hold, which is a quieter error than reporting the
 * deal as unattributed.
 */
export function resolveAttribution(
  touches: readonly AttributionTouch[],
  model: AttributionModel,
): AttributionChoice {
  if (touches.length === 0) return { model, touch: null, unattributedReason: 'no_touches' };

  const ordered = [...touches].sort(
    (a, b) => a.occurredOn.localeCompare(b.occurredOn) || a.clickId.localeCompare(b.clickId),
  );
  const chosen = model === 'first_touch' ? ordered[0]! : ordered[ordered.length - 1]!;

  if (chosen.campaignId == null) {
    return { model, touch: chosen, unattributedReason: 'no_campaign_resolved' };
  }
  return { model, touch: chosen };
}

/** Both models, which are always stored together (§4). */
export function resolveBothModels(
  touches: readonly AttributionTouch[],
): Record<AttributionModel, AttributionChoice> {
  return {
    first_touch: resolveAttribution(touches, 'first_touch'),
    last_touch: resolveAttribution(touches, 'last_touch'),
  };
}

export type ChannelCostPerDeal = {
  /**
   * Every unit of this channel's spend in the period, whether or not it
   * resolved to a campaign. Account-level spend is still this channel's spend;
   * leaving it out would understate the channel's cost.
   */
  channelSpend: number;
  /**
   * Deals attributed to this channel. The only denominator this metric has.
   */
  attributedDeals: number;
  /** Null when no deal is attributed to this channel — not zero, not infinity. */
  value: number | null;
  /**
   * Deals that reached the stage in the period with no channel attributed at
   * all. Reported beside the figure and never inside it: a channel's cost per
   * deal that divides by deals the channel may have had nothing to do with is
   * not a channel metric, it is a flattering one.
   */
  unattributedDeals: number;
  /**
   * Deals attributed to a different channel. Separated from `unattributedDeals`
   * because they cannot move this channel's figure — somebody else's deal is
   * not uncertainty about ours.
   */
  dealsAttributedElsewhere: number;
  /**
   * How far the unattributed deals could move the figure if they were resolved.
   *
   * A bracket, not a confidence interval and not an estimate. `high` is the
   * confirmed value — none of the unattributed deals belong to this channel.
   * `low` assumes every one of them does, which is the most generous reading
   * the data permits. The truth is inside, and usually not at either end.
   *
   * Rendered as a range so the uncertainty is visible. A single number here
   * would be a claim the attribution cannot support, and the gap between the
   * ends is exactly the cost of the coverage problem.
   */
  plausibleRange: { low: number | null; high: number | null };
};

/**
 * A channel's spend divided by the deals attributed to that channel (§8).
 *
 * The denominator is the whole point. Funded deals arrive from organic,
 * referral, outbound and repeat business as well as from paid media, so
 * dividing one channel's spend by every deal in the period produces a number
 * that is not wrong so much as meaningless — it improves whenever the sales
 * team has a good month and would keep improving if the channel were switched
 * off. A channel metric divides that channel's spend by that channel's deals,
 * and says separately how many deals it could not speak for.
 *
 * Generic across stages: cost per funded deal is this with the value stage,
 * cost per offer is this with the offer stage. The metric does not know which
 * stage a tenant calls valuable — `funnel_stages.counts_value` does.
 *
 * Blended cost per deal across every channel is a different metric with a
 * different denominator — total marketing spend over total marketing-sourced
 * deals — and it is not this function with the arguments added up. It needs
 * every channel ingested before it means anything.
 */
export function channelCostPerDeal(input: {
  channelSpend: number;
  attributedDeals: number;
  unattributedDeals?: number;
  dealsAttributedElsewhere?: number;
}): ChannelCostPerDeal {
  const { channelSpend, attributedDeals } = input;
  const unattributedDeals = input.unattributedDeals ?? 0;
  const value = attributedDeals === 0 ? null : channelSpend / attributedDeals;
  const mostGenerousDenominator = attributedDeals + unattributedDeals;

  return {
    channelSpend,
    attributedDeals,
    value,
    unattributedDeals,
    dealsAttributedElsewhere: input.dealsAttributedElsewhere ?? 0,
    plausibleRange: {
      low: mostGenerousDenominator === 0 ? null : channelSpend / mostGenerousDenominator,
      high: value,
    },
  };
}

/**
 * Cost per funded deal for one channel — the north star (§8), named because the
 * product names it, and one call to `channelCostPerDeal`.
 */
export function costPerFundedDeal(input: {
  channelSpend: number;
  attributedDeals: number;
  unattributedDeals?: number;
  dealsAttributedElsewhere?: number;
}): ChannelCostPerDeal {
  return channelCostPerDeal(input);
}

export type AttributionCoverage = {
  total: number;
  attributed: number;
  /** No click id at all: the deal did not come from a paid click. */
  noTouches: number;
  /**
   * A click id exists but no campaign stands behind it. Usually the click has
   * aged out of the platform's lookback window, which is permanent.
   */
  clickWithoutCampaign: number;
  /** Null when there are no deals to describe. */
  rate: number | null;
};

/**
 * How much of the funnel the attribution actually covers.
 *
 * Rendered beside every attributed figure. The brief's rule is that a number
 * without a resolvable source does not render; this is the same principle one
 * level up — an attributed total whose coverage is unstated invites the reader
 * to assume it is complete.
 */
export function attributionCoverage(
  choices: readonly AttributionChoice[],
): AttributionCoverage {
  let attributed = 0;
  let noTouches = 0;
  let clickWithoutCampaign = 0;

  for (const choice of choices) {
    if (choice.unattributedReason === 'no_touches') noTouches += 1;
    else if (choice.unattributedReason === 'no_campaign_resolved') clickWithoutCampaign += 1;
    else attributed += 1;
  }

  return {
    total: choices.length,
    attributed,
    noTouches,
    clickWithoutCampaign,
    rate: choices.length === 0 ? null : attributed / choices.length,
  };
}
