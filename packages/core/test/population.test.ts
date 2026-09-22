import { describe, expect, it } from 'vitest';
import {
  assessPopulation,
  declaredFormulas,
  gatedFormulas,
  improvementDirectionFor,
  needsPopulation,
  populationNoun,
} from '../src';

/**
 * The population gate.
 *
 * The thing being prevented is narrow and expensive: a cost per funded deal
 * over two deals, or an offer rate over four submissions, rendered on the
 * executive screen looking exactly like the ninety-day figure. Every test here
 * is a case where the arithmetic is right and the figure is not a measurement.
 */
describe('which formulas need a population', () => {
  it('gates the ratios and leaves the counts alone', () => {
    expect(needsPopulation('cost_per_funded_deal')).toBe(true);
    expect(needsPopulation('attributed_share')).toBe(true);
    expect(needsPopulation('submission_offer_rate')).toBe(true);
    expect(needsPopulation('speed_to_lead')).toBe(true);

    // A count is true at any size. Three funded deals is three funded deals,
    // and withholding it would be withholding a fact.
    expect(needsPopulation('stage_count')).toBe(false);
    expect(needsPopulation('funded_volume')).toBe(false);
    expect(needsPopulation('paid_media_spend')).toBe(false);
    expect(needsPopulation('leads_created')).toBe(false);
    expect(needsPopulation('calls_handled')).toBe(false);
  });

  it('gates an undeclared ratio, which is the case it exists for', () => {
    // Somebody adds this next month and forgets to declare it. The cost of
    // being wrong in this direction is an amber badge; the cost of being wrong
    // in the other is a figure built on two records.
    expect(needsPopulation('reply_rate')).toBe(true);
    expect(needsPopulation('cost_per_mql')).toBe(true);
    expect(needsPopulation('median_time_to_close')).toBe(true);
    expect(needsPopulation('impressions')).toBe(false);
  });

  it('names the population rather than leaving the reader to guess it', () => {
    // "Fewer than 10" invites "ten of what", and for a channel metric the
    // answer is the separation rule restated.
    expect(populationNoun('cost_per_funded_deal')).toBe('deals attributed to this channel');
    expect(populationNoun('cost_per_funded_deal', 1)).toBe('deal attributed to this channel');
    expect(populationNoun('submission_offer_rate')).toBe('submissions a lender has decided');
  });
});

describe('assessPopulation', () => {
  it('withholds a figure below the floor and says what it was over', () => {
    const verdict = assessPopulation('cost_per_funded_deal', 3, 10);
    expect(verdict.sufficient).toBe(false);
    expect(verdict.population).toBe(3);
    expect(verdict.minimum).toBe(10);
    expect(verdict.reason).toBe('3 deals attributed to this channel, below the 10 this figure needs.');
  });

  it('renders at the floor exactly, not above it', () => {
    expect(assessPopulation('attributed_share', 10, 10).sufficient).toBe(true);
    expect(assessPopulation('attributed_share', 9, 10).sufficient).toBe(false);
  });

  it('distinguishes nothing at all from too little', () => {
    // Different sentences because they are different facts, and the first is
    // the one a reader can act on by widening the range.
    expect(assessPopulation('speed_to_lead', 0, 10).reason).toBe(
      'No leads with an outbound call in this range.',
    );
    expect(assessPopulation('speed_to_lead', 1, 10).reason).toBe(
      '1 lead with an outbound call, below the 10 this figure needs.',
    );
  });

  it('never gates a count, however small', () => {
    const verdict = assessPopulation('stage_count', 1, 10);
    expect(verdict.sufficient).toBe(true);
    expect(verdict.reason).toBeNull();
  });

  it('carries the population even where the figure renders', () => {
    // A card may want to state the denominator whether or not it was the
    // reason to withhold anything.
    expect(assessPopulation('attributed_share', 41, 10).population).toBe(41);
  });

  it('treats a nonsense floor as no floor rather than throwing on a page render', () => {
    expect(assessPopulation('attributed_share', 0, 0).sufficient).toBe(true);
    expect(assessPopulation('attributed_share', 4, -5).sufficient).toBe(true);
  });
});

describe('the two metric tables together', () => {
  it('declares a direction for every gated formula', () => {
    // A figure that renders and carries an uncoloured delta is a smaller
    // problem than one that does not render at all, but both are gaps in the
    // same declaration, and a formula worth gating is worth assessing.
    const undeclared = gatedFormulas().filter(
      (formula) => improvementDirectionFor(formula) === null,
    );
    expect(undeclared).toEqual([]);
  });

  it('gates none of the formulas declared neutral, which are all volumes', () => {
    const neutral = declaredFormulas().filter(
      (formula) => improvementDirectionFor(formula) === null,
    );
    expect(neutral.filter((formula) => needsPopulation(formula))).toEqual([]);
  });
});
