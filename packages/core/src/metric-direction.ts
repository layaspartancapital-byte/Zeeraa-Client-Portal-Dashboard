import type { ImprovementDirection } from './format';

/**
 * Which way is better, declared once per metric formula.
 *
 * Green and red mean improvement and regression, and nothing else. Which way
 * that runs is a property of the metric itself — a cost per funded deal that
 * falls is good news for every client there will ever be — so it is declared
 * here beside the functions that compute these metrics, not decided by whoever
 * writes the card.
 *
 * **Keyed on `formula_key`, not on the tenant's metric key.** `formula_key`
 * names the function in this package; the metric key is the tenant's own name
 * for an instance of it, and two tenants may call `cost_per_stage` different
 * things. The formula is what fixes the direction.
 *
 * This is not client-specific configuration and so does not belong in a config
 * row: there is no client for whom rising costs are an achievement.
 * `tenant_metrics.improvement_direction` survives as a fallback for a formula
 * this table has never heard of, and is overridden wherever they disagree —
 * a misconfigured row cannot paint a rising cost green.
 */
const FORMULA_DIRECTION: Record<string, ImprovementDirection | null> = {
  /* Lower is better — every one of these is money spent or time taken. */
  cost_per_funded_deal: 'down',
  cost_per_stage: 'down',
  cost_per_conversion: 'down',
  total_program_cost: 'down',
  cpc: 'down',
  cpm: 'down',
  cpa: 'down',
  stage_velocity: 'down',
  /* Rates are not uniformly one way, which is why this is a table and not a
     rule about the word "rate". A duplicate is waste and a resubmission is
     rework; both falling is the good outcome. */
  duplicate_rate: 'down',
  resubmission_rate: 'down',

  /* Higher is better. */
  funded_volume: 'up',
  stage_count: 'up',
  stage_conversion_rate: 'up',
  submission_offer_rate: 'up',
  qualified_rate: 'up',
  attributed_share: 'up',
  ctr: 'up',
  conversion_rate: 'up',
  connect_rate: 'up',

  /**
   * Declared neutral, not left out.
   *
   * Spending less is not an achievement and spending more is not a failure —
   * it is a decision, and the metric that judges it is cost per deal. Written
   * down so that it reads as a decision rather than as a gap somebody forgot to
   * fill, and so a stray `improvement_direction` on a config row cannot colour
   * it.
   */
  paid_media_spend: null,
  spend: null,
  impressions: null,
  clicks: null,
};

/**
 * A formula this table has not heard of, whose name says it is a cost.
 *
 * The safety net for the case the whole module exists to prevent: somebody adds
 * `cost_per_mql` next month, forgets to declare it, and a rising cost renders
 * green because "up" was the obvious default. There is no default of `up` here
 * — an undeclared formula is neutral, and an undeclared *cost* is `down`.
 */
const COST_SHAPED = /(^|_)(cost|cpa|cpc|cpm|cpl|cac|spend_per)(_|$)/;

export function looksLikeCost(formulaKey: string): boolean {
  return COST_SHAPED.test(formulaKey);
}

/**
 * The direction to colour a change in this metric, or null for no assessment.
 *
 * `configured` is the tenant's `improvement_direction`, consulted **last** and
 * only for a formula this package does not declare — a tenant may define a
 * metric this codebase has never seen, and that one still has to render.
 */
export function improvementDirectionFor(
  formulaKey: string,
  configured: ImprovementDirection | null = null,
): ImprovementDirection | null {
  if (Object.hasOwn(FORMULA_DIRECTION, formulaKey)) return FORMULA_DIRECTION[formulaKey]!;
  if (looksLikeCost(formulaKey)) return 'down';
  return configured;
}

/** Every formula with a declared direction. For the test that seeds agree. */
export function declaredFormulas(): string[] {
  return Object.keys(FORMULA_DIRECTION);
}
