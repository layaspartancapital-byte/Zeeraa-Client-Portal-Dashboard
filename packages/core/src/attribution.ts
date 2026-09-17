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

export type CostPerFundedDeal = {
  spend: number;
  fundedDeals: number;
  /** Null when no deal funded in the period — not zero, and not infinity. */
  value: number | null;
  /**
   * Spend that reached no funded deal, and funded deals that reached no spend.
   * Both are reported rather than folded in: a cost per funded deal computed
   * over attributed spend alone flatters itself, and one computed over all
   * spend while counting only attributed deals does the opposite.
   */
  unattributedSpend: number;
  unattributedFundedDeals: number;
};

/**
 * Attributed media spend and fees divided by deals that reached Funded in the
 * same period (§8).
 *
 * Returns null on a zero denominator. A period with spend and no funded deals
 * does not have an infinite cost per deal, and it does not have a cost of zero;
 * it has no cost per deal, and the UI renders that as an explicit empty state
 * rather than as a number.
 *
 * The two unattributed figures are part of the result, not a diagnostic beside
 * it. Spartan's click-ID coverage is partial by construction — `gclid` reaches
 * 37.4% of converted leads and `click_view` only serves 90 days — so a caller
 * that cannot see the unattributed share cannot tell a good cost per deal from
 * a well-attributed fraction of a bad one.
 */
export function costPerFundedDeal(input: {
  attributedSpend: number;
  unattributedSpend?: number;
  fundedDeals: number;
  unattributedFundedDeals?: number;
}): CostPerFundedDeal {
  const spend = input.attributedSpend;
  const fundedDeals = input.fundedDeals;
  return {
    spend,
    fundedDeals,
    value: fundedDeals === 0 ? null : spend / fundedDeals,
    unattributedSpend: input.unattributedSpend ?? 0,
    unattributedFundedDeals: input.unattributedFundedDeals ?? 0,
  };
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
