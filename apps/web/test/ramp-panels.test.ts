/**
 * The executive scorecard: four figures against this month's target, judged
 * by `scorecardVerdict`, and a month with no target saying why instead of
 * showing a zero or a gap.
 */
import { describe, expect, it } from 'vitest';
import type { MonthActual, PopulationVerdict, RampTarget } from '@zeeraa/core';
import { scorecardRows, type RampPanels } from '../src/lib/ramp-panels';
import type { Metrics } from '../src/lib/dashboard';

const actual = (value: number | null, attributed?: number): MonthActual =>
  ({
    value,
    reason: value === null ? 'Not read.' : null,
    ...(attributed === undefined ? {} : { cost: { value, attributedDeals: attributed } }),
  }) as unknown as MonthActual;

const panel = (metric: string) => ({ metric, label: metric, format: { kind: 'projection' } });

const panels = (
  startMonth: string | null,
  targets: Partial<RampTarget>[],
  values: Record<string, MonthActual>,
): RampPanels =>
  ({
    platform: 'google_ads',
    channel: 'Google Ads',
    startMonth,
    targets: targets as RampTarget[],
    primary: panel('costPerFundedDeal'),
    secondary: panel('cpa'),
    compact: ['budget', 'approvals', 'fundedDeals', 'fundedAmount'].map(panel),
    monthActual: (metric: string) => values[metric] ?? actual(null),
  }) as unknown as RampPanels;

const metrics = {
  comparable: (_key: string, population: number) =>
    ({ sufficient: population >= 5, reason: population >= 5 ? null : 'Fewer than 5 deals.' }) as PopulationVerdict,
} as unknown as Metrics;

const run = (p: RampPanels, currentMonth: string, elapsed = 0.8) =>
  Object.fromEntries(
    scorecardRows(p, { currentMonth, elapsed, metrics, valueLabel: 'Funded' }).map((r) => [r.metric, r]),
  );

describe('scorecardRows', () => {
  const m1 = { monthIndex: 1, costPerFundedDeal: 4000, cpa: 1000, fundedDeals: 10, budget: 30000 } as never;

  it('draws the four scorecard metrics, in order', () => {
    const rows = scorecardRows(panels('2026-10', [m1], {}), {
      currentMonth: '2026-10',
      elapsed: 0.5,
      metrics,
      valueLabel: 'Funded',
    });
    expect(rows.map((r) => r.label)).toEqual(['Cost per funded deal', 'CPA', 'Funded deals', 'Spend']);
  });

  it('judges a cost as it stands and a count against pace', () => {
    const rows = run(
      panels('2026-10', [m1], {
        costPerFundedDeal: actual(5000, 6),
        fundedDeals: actual(8),
        budget: actual(24000),
      }),
      '2026-10',
    );
    expect(rows.costPerFundedDeal!.verdict).toEqual({ state: 'behind', by: 1000, paced: false });
    // 8 of 10 with 80% of the month gone is on pace, not 2 behind.
    expect(rows.fundedDeals!.verdict).toEqual({ state: 'on_target', paced: true });
    expect(rows.budget!.verdict).toEqual({ state: 'on_target', paced: true });
  });

  it('compares a cost over any number of deals (no minimum, 24 September 2026)', () => {
    const rows = run(panels('2026-10', [m1], { costPerFundedDeal: actual(9000, 2) }), '2026-10');
    expect(rows.costPerFundedDeal!.verdict).toEqual({ state: 'behind', by: 5000, paced: false });
  });

  it('before M1 names the first target and never computes a verdict', () => {
    const rows = run(panels('2026-10', [m1], { fundedDeals: actual(3) }), '2026-09');
    expect(rows.fundedDeals).toMatchObject({
      target: null,
      upcoming: { month: '2026-10', value: 10 },
      verdict: { state: 'no_target' },
    });
  });

  it('keeps an unmeasured actual unmeasured, not zero', () => {
    const rows = run(panels('2026-10', [m1], {}), '2026-10');
    expect(rows.budget!.actual.value).toBeNull();
    expect(rows.budget!.verdict).toEqual({ state: 'not_measured', reason: 'Not read.' });
  });
});
