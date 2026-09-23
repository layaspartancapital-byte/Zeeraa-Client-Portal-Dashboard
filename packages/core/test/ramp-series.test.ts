import { describe, expect, it } from 'vitest';
import { RAMP_METRICS, briefingPeriods, rampSeries, type RampTarget } from '../src';

/**
 * The contracted curve, as the briefing plots it.
 *
 * The property every test here protects is the one the previous hero got
 * wrong: **the commitment is drawable whether or not anybody has recorded when
 * the engagement starts.** A contract says M1 costs $4,000; it does not say
 * when M1 is. Plotting on a calendar axis conflated those and rendered an empty
 * chart against a fully specified curve.
 */
const SPARTAN: RampTarget[] = [
  { monthIndex: 1, costPerFundedDeal: 4000, budget: 30000, cpa: null, approvals: null, fundedDeals: null, fundedAmount: null },
  { monthIndex: 2, costPerFundedDeal: 3680, budget: null, cpa: null, approvals: null, fundedDeals: null, fundedAmount: null },
  { monthIndex: 3, costPerFundedDeal: 3496, budget: null, cpa: null, approvals: null, fundedDeals: null, fundedAmount: null },
];

describe('rampSeries', () => {
  it('draws the commitment with no start month recorded', () => {
    const series = rampSeries(SPARTAN, 'costPerFundedDeal', { startMonth: null });

    expect(series.contracted).toBe(true);
    expect(series.measured).toBe(false);
    expect(series.points.map((p) => p.label)).toEqual(['M1', 'M2', 'M3']);
    expect(series.points.map((p) => p.target)).toEqual([4000, 3680, 3496]);
    // No calendar month, so no actual and no gap — but the curve is there.
    expect(series.points.every((p) => p.month === null)).toBe(true);
    expect(series.points.every((p) => p.actual === null)).toBe(true);
    expect(series.first).toBe(4000);
    expect(series.last).toBe(3496);
  });

  it('never calls for an actual while the start month is unrecorded', () => {
    // The guard that matters: with no start month there is no calendar month to
    // ask about, so asking anyway would align an actual to a month nobody
    // chose. Assuming the engagement began when ingestion did is exactly the
    // mistake the start month exists to prevent.
    let asked = 0;
    rampSeries(SPARTAN, 'costPerFundedDeal', {
      startMonth: null,
      actualFor: () => {
        asked += 1;
        return 9999;
      },
    });
    expect(asked).toBe(0);
  });

  it('maps each ramp month onto its calendar month once the start is recorded', () => {
    const actuals: Record<string, number> = { '2026-06': 4200, '2026-07': 3600 };
    const series = rampSeries(SPARTAN, 'costPerFundedDeal', {
      startMonth: '2026-06',
      actualFor: (month) => actuals[month] ?? null,
      direction: 'down',
    });

    expect(series.points.map((p) => p.month)).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(series.points.map((p) => p.actual)).toEqual([4200, 3600, null]);
    expect(series.measured).toBe(true);
  });

  it('assesses the gap by the metric direction, so a cost under target is ahead', () => {
    const series = rampSeries(SPARTAN, 'costPerFundedDeal', {
      startMonth: '2026-06',
      actualFor: (month) => (month === '2026-07' ? 3600 : null),
      direction: 'down',
    });

    const m2 = series.points[1]!;
    expect(m2.gap?.absolute).toBe(-80);
    expect(m2.gap?.target).toBe(3680);
    // Below target on a cost is an improvement, which is the whole reason the
    // direction is passed in rather than inferred from the sign.
    expect(m2.gap?.assessment).toBe('ahead');
  });

  it('reports a metric nobody contracted as uncontracted rather than as zero', () => {
    // Four of the five curves are in this state today. The screen has to say
    // "not recorded", and a series of zeroes would say the engagement
    // contracted nothing.
    const series = rampSeries(SPARTAN, 'cpa', { startMonth: '2026-06' });
    expect(series.contracted).toBe(false);
    expect(series.first).toBeNull();
    expect(series.points.every((p) => p.target === null)).toBe(true);
  });

  it('carries a month that contracts nothing without dropping it from the axis', () => {
    // Budget exists on M1 only. M2 and M3 keep their place on the axis with a
    // null target, so the curve has a hole rather than being three months long
    // and starting in the wrong place.
    const series = rampSeries(SPARTAN, 'budget', { startMonth: null });
    expect(series.contracted).toBe(true);
    expect(series.points.map((p) => p.target)).toEqual([30000, null, null]);
  });

  it('orders by ramp month rather than trusting the row order', () => {
    const shuffled = [SPARTAN[2]!, SPARTAN[0]!, SPARTAN[1]!];
    const series = rampSeries(shuffled, 'costPerFundedDeal', { startMonth: null });
    expect(series.points.map((p) => p.monthIndex)).toEqual([1, 2, 3]);
  });

  it('has no gap where only one half exists', () => {
    const series = rampSeries(SPARTAN, 'budget', {
      startMonth: '2026-06',
      actualFor: () => 25000,
      direction: null,
    });
    // M2 and M3 have an actual and no target; and with no direction there is
    // nothing to assess even on M1.
    expect(series.points.every((p) => p.gap === null)).toBe(true);
  });

  it('names every contracted metric, so a new column cannot appear unannounced', () => {
    expect(RAMP_METRICS).toEqual([
      'costPerFundedDeal',
      'cpa',
      'budget',
      'approvals',
      'fundedDeals',
      'fundedAmount',
    ]);
  });
});

describe('briefingPeriods', () => {
  it('resolves month to date and the last whole month', () => {
    const periods = briefingPeriods('2026-09-22');
    expect(periods.monthToDate).toEqual({ start: '2026-09-01', end: '2026-09-22' });
    expect(periods.lastFullMonth).toEqual({ start: '2026-08-01', end: '2026-08-31' });
    expect(periods.currentMonth).toBe('2026-09');
  });

  it('counts today as elapsed, because the budget is being spent across it', () => {
    // Measuring to yesterday would report every account as a day behind on
    // every day of the month.
    const periods = briefingPeriods('2026-09-22');
    expect(periods.elapsedDays).toBe(22);
    expect(periods.monthDays).toBe(30);
    expect(periods.elapsed).toBeCloseTo(22 / 30, 6);
  });

  it('crosses a year boundary', () => {
    const periods = briefingPeriods('2027-01-05');
    expect(periods.lastFullMonth).toEqual({ start: '2026-12-01', end: '2026-12-31' });
  });

  it('is fully elapsed on the last day of a month', () => {
    const periods = briefingPeriods('2026-08-31');
    expect(periods.elapsed).toBe(1);
  });
});
