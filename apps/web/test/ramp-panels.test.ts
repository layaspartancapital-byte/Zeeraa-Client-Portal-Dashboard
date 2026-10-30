/**
 * The scorecards (30 October 2026): the ramp channel's card carries no target,
 * and every target is the signed contract's, judged by `scorecardVerdict` on
 * the All sources card — a range at its low end, a month before the contract
 * naming the first target instead of inventing one.
 */
import { describe, expect, it } from 'vitest';
import { contractTarget, parseContractTargets, type MonthActual, type PopulationVerdict } from '@zeeraa/core';
import { contractRows, scorecardRows, type RampPanels } from '../src/lib/ramp-panels';
import type { Metrics } from '../src/lib/dashboard';

const actual = (value: number | null, deals?: number): MonthActual =>
  ({
    value,
    reason: value === null ? 'Not read.' : null,
    ...(deals === undefined ? {} : { cost: { value, attributedDeals: deals, channelSpend: (value ?? 0) * deals } }),
  }) as unknown as MonthActual;

const panel = (metric: string, label = metric) => ({ metric, label, format: { kind: 'projection' } });

const contract = parseContractTargets({
  source: 'Zeeraa proposal, page 22',
  cpa: [{ from: '2026-10', value: 1000 }],
  costPerFundedDeal: [{ from: '2026-10', value: 4500 }],
  fundedAmount: [
    { from: '2026-10', low: 100000, high: 150000 },
    { from: '2026-11', value: 200000 },
  ],
});

const panels = (startMonth: string | null, channel: Record<string, MonthActual>, all: Record<string, MonthActual>): RampPanels =>
  ({
    platform: 'google_ads',
    channel: 'Google Ads',
    startMonth,
    targets: [],
    primary: panel('costPerFundedDeal'),
    secondary: panel('cpa'),
    compact: ['budget', 'approvals', 'fundedDeals', 'fundedAmount'].map((m) => panel(m)),
    monthActual: (metric: string) => channel[metric] ?? actual(null),
    contract: {
      source: contract?.source ?? null,
      primary: panel('costPerFundedDeal'),
      panels: Object.fromEntries(
        ['costPerFundedDeal', 'cpa', 'fundedAmount', 'fundedDeals', 'budget', 'approvals'].map((m) => [m, panel(m, `${m} (all sources)`)]),
      ),
      monthActual: (metric: string) => all[metric] ?? actual(null),
      target: (metric: string, month: string) =>
        metric === 'cpa' || metric === 'costPerFundedDeal' || metric === 'fundedAmount' ? contractTarget(contract, metric, month) : null,
    },
  }) as unknown as RampPanels;

const metrics = {
  comparable: (_key: string, population: number) =>
    ({ sufficient: population >= 5, reason: population >= 5 ? null : 'Fewer than 5 deals.' }) as PopulationVerdict,
} as unknown as Metrics;

const input = (currentMonth: string, elapsed = 0.8) => ({ currentMonth, elapsed, metrics, valueLabel: 'Funded' });
const byMetric = <T extends { metric: string }>(rows: T[]) => Object.fromEntries(rows.map((r) => [r.metric, r]));

describe('scorecardRows (the ramp channel)', () => {
  it('draws the channel’s five figures with no target and no verdict', () => {
    const rows = scorecardRows(panels('2026-10', { costPerFundedDeal: actual(5000, 3) }, {}), input('2026-10'));
    expect(rows.map((r) => r.label)).toEqual(['Cost per funded deal', 'CPA', 'Funded deals', 'Funded volume', 'Spend']);
    for (const r of rows) expect(r).toMatchObject({ target: null, verdict: null, untargeted: true });
  });
});

describe('contractRows (All sources, against the contract)', () => {
  it('judges costs as they stand and volume against pace, at a range’s low end', () => {
    const rows = byMetric(
      contractRows(
        panels('2026-10', {}, {
          costPerFundedDeal: actual(5000, 6),
          cpa: actual(900, 40),
          fundedAmount: actual(85000),
          fundedDeals: actual(9),
        }),
        input('2026-10', 0.8),
      ),
    );
    expect(rows.costPerFundedDeal).toMatchObject({ target: 4500, verdict: { state: 'behind', by: 500, paced: false } });
    expect(rows.cpa!.verdict?.state).toBe('on_target');
    // $85K of a $100K floor with 80% of the month gone is on pace.
    expect(rows.fundedAmount).toMatchObject({ target: 100000, targetHigh: 150000, verdict: { state: 'on_target', paced: true } });
    expect(rows.fundedDeals).toMatchObject({ target: null, verdict: null, untargeted: true });
  });

  it('is on target for a finished October at $100K, the range’s low end', () => {
    const rows = byMetric(contractRows(panels('2026-10', {}, { fundedAmount: actual(100000) }), input('2026-10', 1)));
    expect(rows.fundedAmount!.verdict?.state).toBe('on_target');
  });

  it('before the contract starts names the first target and judges nothing', () => {
    const rows = byMetric(contractRows(panels('2026-10', {}, { cpa: actual(1200, 10) }), input('2026-09')));
    expect(rows.cpa).toMatchObject({ target: null, upcoming: { month: '2026-10', value: 1000 }, verdict: { state: 'no_target' } });
  });

  it('keeps an unmeasured month unmeasured, not zero', () => {
    const rows = byMetric(contractRows(panels('2026-10', {}, {}), input('2026-11')));
    expect(rows.fundedAmount!.verdict).toEqual({ state: 'not_measured', reason: 'Not read.' });
  });
});
