import { describe, expect, it } from 'vitest';
import { spartan } from '../seeds/spartan';

/**
 * The contracted ramp, checked against the model's own arithmetic.
 *
 * The figures in the seed are transcribed by hand from
 * `SpartanCapital Google Ads Budget Projection for 8 Months(Sheet1).csv`, which
 * is gitignored, so nothing else in this repository can catch a typo in them.
 * A wrong digit in a contracted target is close to undetectable by eye — the
 * curve still looks like a curve — and it is the number the whole executive
 * briefing is judged against.
 *
 * What makes it checkable is that **the model is internally redundant**. Budget,
 * approvals and funded deals are the primitives; CPA and CPF are computed from
 * them:
 *
 *     CPA = budget ÷ approvals          $30,000 ÷ 40    = $750
 *     CPF = budget ÷ funded deals       $30,000 ÷ 7.5   = $4,000
 *
 * Both hold for all eight months in the source. So re-deriving them here is a
 * checksum over five transcribed columns: change any one figure and at least
 * one of the two ratios stops reproducing.
 *
 * **The tolerance is derived, not chosen.** The model rounds twice, and both
 * roundings land in the comparison:
 *
 *   * the ratio is stated in whole dollars — $58,800 ÷ 86.9 is $676.64, stated
 *     as $677 — which is worth up to $0.50; and
 *   * the *count* is stated to one decimal, which is worth up to 0.05 of a
 *     deal, and that error is divided into the budget. It dominates, and it is
 *     much larger early: 0.05 of a deal against M1's 7.5 is 0.7% of the
 *     denominator, against M8's 116.9 it is 0.04%.
 *
 * So the allowance for a month is `$0.50 + ratio × 0.05 / count`, which is
 * $27 at M1 and $1.66 at M8. A flat tolerance would have to be the M1 figure to
 * pass, and $27 of slack at M8 would let a genuine transcription error through.
 * The first version of this test used a flat $0.50 and failed on five of the
 * eight months — the arithmetic was right and the tolerance was not.
 */
function roundingAllowance(ratio: number, count: number): number {
  return 0.5 + (ratio * 0.05) / count;
}

/** What the TOTAL row of the model states, as a second independent check. */
const STATED_TOTALS = { budget: 1_031_842, approvals: 1794, fundedDeals: 347 };

describe('the seeded engagement model', () => {
  const targets = spartan.engagementTargets.filter((t) => t.platform === 'google_ads');

  it('contracts eight consecutive months, so nothing is missing or duplicated', () => {
    expect(targets).toHaveLength(8);
    expect(targets.map((t) => t.monthIndex)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('states all five series for every month', () => {
    // The point of loading the model was that four of the five curves were
    // absent. A month that quietly kept a gap would render as `Not recorded`
    // on the briefing and nobody would know which month.
    const incomplete = targets
      .filter(
        (t) =>
          t.budget == null ||
          t.cpa == null ||
          t.approvals == null ||
          t.costPerFundedDeal == null ||
          t.fundedDeals == null,
      )
      .map((t) => `M${t.monthIndex}`);
    expect(incomplete).toEqual([]);
  });

  it('reproduces CPA as budget over approvals, every month', () => {
    const wrong = targets
      .map((t) => {
        const derived = t.budget! / t.approvals!;
        const allowed = roundingAllowance(derived, t.approvals!);
        return Math.abs(derived - t.cpa!) <= allowed
          ? null
          : `M${t.monthIndex}: ${t.budget} / ${t.approvals} = ${derived.toFixed(2)}, seed says ${t.cpa} (allowed ±${allowed.toFixed(2)})`;
      })
      .filter(Boolean);
    expect(wrong).toEqual([]);
  });

  it('reproduces CPF as budget over funded deals, every month', () => {
    const wrong = targets
      .map((t) => {
        const derived = t.budget! / t.fundedDeals!;
        const allowed = roundingAllowance(derived, t.fundedDeals!);
        return Math.abs(derived - t.costPerFundedDeal!) <= allowed
          ? null
          : `M${t.monthIndex}: ${t.budget} / ${t.fundedDeals} = ${derived.toFixed(2)}, seed says ${t.costPerFundedDeal} (allowed ±${allowed.toFixed(2)})`;
      })
      .filter(Boolean);
    expect(wrong).toEqual([]);
  });

  it('would catch a transcription error, so the checksum is not vacuous', () => {
    // A single wrong digit in the budget column, which is the failure this
    // whole file exists to catch. M5's $115,248 mistyped as $115,428 moves the
    // derived CPF by $4.93 against an allowance of $4.83 — the margin is thin,
    // which is the point: the allowance is the rounding and nothing more.
    const mistyped = { budget: 125248, fundedDeals: 36.5, costPerFundedDeal: 3155 };
    const derived = mistyped.budget / mistyped.fundedDeals;
    expect(Math.abs(derived - mistyped.costPerFundedDeal)).toBeGreaterThan(
      roundingAllowance(derived, mistyped.fundedDeals),
    );
  });

  it('sums to the totals the model states', () => {
    // A second, independent check on the same five columns: the source carries
    // a TOTAL row, and a transcription error that somehow preserved both ratios
    // would still move a sum.
    const sum = (pick: (t: (typeof targets)[number]) => number | undefined) =>
      targets.reduce((total, t) => total + (pick(t) ?? 0), 0);

    expect(sum((t) => t.budget)).toBe(STATED_TOTALS.budget);
    expect(sum((t) => t.approvals)).toBeCloseTo(STATED_TOTALS.approvals, 1);
    expect(sum((t) => t.fundedDeals)).toBeCloseTo(STATED_TOTALS.fundedDeals, 1);
  });

  it('keeps the fractional projections that the ratios depend on', () => {
    // The guard on migration 0021. Rounding M1's 7.5 funded deals to 8 gives a
    // cost per funded deal of $3,750 against a contract that says $4,000 — a 6%
    // error in the north-star target, arriving as a rounding decision nobody
    // made on purpose. If these ever become whole numbers, that happened.
    const fractional = targets.filter(
      (t) => !Number.isInteger(t.fundedDeals!) || !Number.isInteger(t.approvals!),
    );
    expect(fractional.length).toBeGreaterThan(0);
    expect(targets[0]!.fundedDeals).toBe(7.5);
  });

  it('declines month on month on both costs, which is what a ramp is', () => {
    const rising: string[] = [];
    for (let i = 1; i < targets.length; i += 1) {
      const previous = targets[i - 1]!;
      const current = targets[i]!;
      if (current.cpa! > previous.cpa!) rising.push(`CPA at M${current.monthIndex}`);
      if (current.costPerFundedDeal! > previous.costPerFundedDeal!) {
        rising.push(`CPF at M${current.monthIndex}`);
      }
    }
    expect(rising).toEqual([]);
  });

  it('grows budget, approvals and funded deals month on month', () => {
    const falling: string[] = [];
    for (let i = 1; i < targets.length; i += 1) {
      const previous = targets[i - 1]!;
      const current = targets[i]!;
      if (current.budget! < previous.budget!) falling.push(`budget at M${current.monthIndex}`);
      if (current.approvals! < previous.approvals!) falling.push(`approvals at M${current.monthIndex}`);
      if (current.fundedDeals! < previous.fundedDeals!) {
        falling.push(`funded deals at M${current.monthIndex}`);
      }
    }
    expect(falling).toEqual([]);
  });

  it('contracts a curve for Google Ads and for nothing else', () => {
    // Meta must not inherit a target. A ramp is per channel, and rendering
    // Google's curve under Meta's name would put a number on screen that no
    // contract states.
    expect([...new Set(spartan.engagementTargets.map((t) => t.platform))]).toEqual(['google_ads']);
  });
});
