/**
 * Which metrics need a minimum population before they mean anything.
 *
 * A count is true at any size: three funded deals is three funded deals, and
 * rendering it is not a claim about anything else. A *ratio* is different. Cost
 * per funded deal over three deals moves by a third when one deal lands, an
 * offer rate over four submissions can only take five values, and a median over
 * two leads is one of the two. Each of those is arithmetically correct and
 * reads on screen as a measurement of the channel rather than of the sample.
 *
 * The split follows the same line as `metric-direction`:
 *
 *   * **Whether a formula needs a population, and what that population is, are
 *     properties of the formula.** There is no client for whom a cost per deal
 *     over two deals is a stable figure. So they are declared here, keyed on
 *     `formula_key`, beside the functions that compute these metrics.
 *   * **How large the population has to be is a judgement about a client's
 *     volumes.** Spartan funds roughly seven deals a month; a client funding
 *     four hundred would set a different bar. So the floor itself stays in the
 *     `min_rate_denominator` config row, which already existed for this and was
 *     being loaded by two screens and used by neither.
 *
 * Below the floor the figure does not render. It is not rounded, not starred
 * and not shown small — it gets the amber `Not measured` treatment every other
 * unmeasurable figure on these screens gets, with the population in the
 * tooltip. A number a reader has to know to distrust is worse than no number.
 */

/**
 * The formulas whose figure is withheld below a population, and the noun for
 * the population in question.
 *
 * The noun matters as much as the number. "Fewer than 10" invites the reader to
 * ask ten of what, and for a channel metric the answer — deals attributed to
 * *this* channel, not deals in the period — is the whole separation rule
 * restated in the one place a reader is already asking the question.
 */
const NEEDS_POPULATION: Record<string, PopulationNoun> = {
  /* Channel metrics: the denominator is that channel's own deals. */
  cost_per_funded_deal: ['deal attributed to this channel', 'deals attributed to this channel'],
  cost_per_stage: ['deal attributed to this channel', 'deals attributed to this channel'],
  cost_per_conversion: [
    'conversion attributed to this channel',
    'conversions attributed to this channel',
  ],
  cpa: ['conversion attributed to this channel', 'conversions attributed to this channel'],

  /* Rates over a stated population. */
  attributed_share: ['deal reaching the value stage', 'deals reaching the value stage'],
  stage_conversion_rate: ['deal reaching the earlier stage', 'deals reaching the earlier stage'],
  submission_offer_rate: [
    'submission a lender has decided',
    'submissions a lender has decided',
  ],
  qualified_rate: ['lead assessed against the bar', 'leads assessed against the bar'],
  conversion_rate: ['click in the period', 'clicks in the period'],
  connect_rate: ['call the desk handled', 'calls the desk handled'],
  duplicate_rate: ['lead in the period', 'leads in the period'],
  resubmission_rate: ['submission in the period', 'submissions in the period'],

  /* Order statistics. A median over four leads is one of the four. */
  speed_to_lead: ['lead with an outbound call', 'leads with an outbound call'],
  stage_velocity: ['deal that reached the stage', 'deals that reached the stage'],
};

/**
 * Singular and plural, written out rather than derived.
 *
 * "1 deals attributed to this channel" is exactly the kind of small wrongness
 * that makes a reader distrust the figure beside it, and the populations here
 * do not pluralise by adding an s to the last word.
 */
export type PopulationNoun = readonly [one: string, many: string];

/**
 * A formula this table has not heard of, whose name says it is a ratio.
 *
 * The same safety net `looksLikeCost` is in `metric-direction`, for the same
 * failure: somebody adds `cost_per_mql` or `reply_rate` next month, forgets to
 * declare it, and it renders a figure built on two records. An undeclared
 * *count* is ungated, which is correct; an undeclared ratio is gated, and the
 * cost of getting that wrong is an amber badge rather than a wrong number.
 */
const RATIO_SHAPED = /(^|_)(rate|share|ratio|median|cost|cpa|cpc|cpl|cac|per)(_|$)/;

export function needsPopulation(formulaKey: string): boolean {
  return Object.hasOwn(NEEDS_POPULATION, formulaKey) || RATIO_SHAPED.test(formulaKey);
}

/** What this formula's population is called, for the line that states it. */
export function populationNoun(formulaKey: string, count = 2): string {
  const noun = NEEDS_POPULATION[formulaKey] ?? (['record in this range', 'records in this range'] as const);
  return count === 1 ? noun[0] : noun[1];
}

export type PopulationVerdict = {
  /** True where the figure may render. */
  sufficient: boolean;
  /** What the figure was computed over. */
  population: number;
  minimum: number;
  noun: string;
  /**
   * Why the figure is withheld, or null where it is not. One sentence for the
   * card's muted line, so no screen has to phrase this itself and five screens
   * cannot phrase it five ways.
   */
  reason: string | null;
};

/**
 * Whether a figure over this population may render.
 *
 * `minimum` comes from the tenant's `min_rate_denominator`. A formula this
 * module does not gate is always sufficient, whatever the population — the
 * verdict still carries the count, because a card may want to state it either
 * way.
 */
export function assessPopulation(
  formulaKey: string,
  population: number,
  minimum: number,
): PopulationVerdict {
  const count = Math.max(0, Math.trunc(population));
  const floor = Math.max(0, Math.trunc(minimum));
  const noun = populationNoun(formulaKey, count);

  if (!needsPopulation(formulaKey) || count >= floor) {
    return { sufficient: true, population: count, minimum: floor, noun, reason: null };
  }

  return {
    sufficient: false,
    population: count,
    minimum: floor,
    noun,
    reason:
      count === 0
        ? `No ${populationNoun(formulaKey)} in this range.`
        : `${count} ${noun}, below the ${floor} this figure needs.`,
  };
}

/** Every gated formula. For the test that this table and the seeds agree. */
export function gatedFormulas(): string[] {
  return Object.keys(NEEDS_POPULATION);
}
