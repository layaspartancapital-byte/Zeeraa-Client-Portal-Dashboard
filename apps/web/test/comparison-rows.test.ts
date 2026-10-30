/**
 * The Comparison page's rows (30 October 2026): "—" where a source has no
 * figure, never 0; a change coloured by the metric's own direction; a frozen
 * month read from its frozen figures; the contract's targets on All sources
 * only; and a note when the periods differ in length.
 */
import { describe, expect, it } from 'vitest';
import type { PopulationVerdict } from '@zeeraa/core';
import { compareRows, lengthNote, periodRows, type PeriodInput } from '../src/lib/comparison-rows';
import type { MonthlyPerformance } from '../src/lib/reporting';

const stages = [
  { key: 'lead', label: 'Lead', position: 1, isOptimizationTarget: false, countsValue: false, source: 'leads' },
  { key: 'mql', label: 'MQL', position: 2, isOptimizationTarget: false, countsValue: false, source: 'qualified_leads' },
  { key: 'application', label: 'Application', position: 3, isOptimizationTarget: false, countsValue: false, source: 'stage_events' },
  { key: 'uw_approved', label: 'UW approved', position: 4, isOptimizationTarget: false, countsValue: false, source: 'stage_events' },
  { key: 'funded', label: 'Funded', position: 5, isOptimizationTarget: false, countsValue: true, source: 'stage_events' },
];

const counts = (lead: number, mql: number, app: number, ok: number, funded: number) => ({ lead, mql, application: app, uw_approved: ok, funded });
const cohorts = { lead: { size: 100, reached: { mql: 40 } }, mql: { size: 40, reached: {} } };

const mp = (spend: number, funded: number, volume: number): MonthlyPerformance =>
  ({
    stages,
    stageStatus: {},
    valueStageKey: 'funded',
    channels: [
      { platform: 'google_ads', label: 'Google Ads', paid: true, spend, impressions: 10000, clicks: 500, stages: counts(100, 40, 20, 10, funded), cohorts, valueVolume: volume, offered: { amount: 50000, deals: 2 } },
      { platform: 'organic_search', label: 'SEO/Organic', paid: false, spend: 0, impressions: 0, clicks: 0, stages: counts(30, 10, 5, 2, 1), cohorts, valueVolume: 20000, offered: { amount: 0, deals: 0 } },
      { platform: 'vendor:Popcrumbs', label: 'Popcrumbs', paid: false, spend: 0, impressions: 0, clicks: 0, stages: counts(50, 45, 2, 1, 1), cohorts, valueVolume: 30000, offered: { amount: 0, deals: 0 } },
    ],
    unattributed: { stages: counts(10, 2, 1, 0, 0), cohorts, valueVolume: 0, offered: { amount: 0, deals: 0 } },
    total: { spend, impressions: 10000, clicks: 500, stages: counts(190, 97, 28, 13, funded + 2), cohorts, valueVolume: volume + 50000, offered: { amount: 50000, deals: 2 } },
  }) as unknown as MonthlyPerformance;

const population = (_key: string, n: number) =>
  ({ sufficient: n >= 5, reason: n >= 5 ? null : 'Fewer than 5.' }) as PopulationVerdict;

const input = (over: Partial<PeriodInput>): PeriodInput => ({
  range: { start: '2026-09-01', end: '2026-09-30' },
  mp: mp(20000, 4, 120000),
  source: 'all',
  crmUnmeasured: null,
  spendUnmeasured: null,
  callsUnmeasured: null,
  frozen: null,
  calls: { handled: 900, connectRate: 0.3, medianSeconds: 240, withinFiveShare: 0.55, called: 300 },
  seo: { organicKeywords: 1200, top10: 90, visibility: 4.2 },
  contract: { cpa: { low: 1000, high: null }, costPerFundedDeal: { low: 4500, high: null }, fundedAmount: { low: 100000, high: 150000 } },
  population,
  ...over,
});

describe('periodRows', () => {
  it('gives a source with no ad spend "—" for every ad and cost figure, and real counts', () => {
    const rows = periodRows(input({ source: 'organic_search' }));
    for (const key of ['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpl', 'cpa', 'cpfd']) {
      expect(rows.get(key)!.cell).toMatchObject({ value: null, reason: 'SEO/Organic has no ad spend.' });
    }
    expect(rows.get('leads')!.cell.value).toBe(30);
    expect(rows.get('calls')!.cell).toMatchObject({ value: null, reason: 'Calls are not split by source.' });
    expect(rows.has('organic_keywords')).toBe(true);
  });

  it('costs All sources as every ad platform’s spend over every source’s records, with the contract’s targets', () => {
    const rows = periodRows(input({}));
    expect(rows.get('cpfd')!.cell).toMatchObject({ value: 20000 / 6, basis: { n: 6, noun: 'deals' }, target: { low: 4500 } });
    expect(rows.get('cpa')!.cell.target).toEqual({ low: 1000, high: null });
    // The contract's volume measure leaves vendors out, in its own row.
    expect(rows.get('funded_volume_contract')!.cell).toMatchObject({ value: 120000 + 20000, target: { low: 100000, high: 150000 } });
  });

  it('puts no contract target beside a single source', () => {
    const rows = periodRows(input({ source: 'google_ads' }));
    expect(rows.get('cpfd')!.cell.target).toBeNull();
    expect(rows.has('funded_volume_contract')).toBe(false);
  });

  it('reads a frozen month’s spend and counts from its frozen figures', () => {
    const frozen = new Map([
      ['google_ads|spend', 19000],
      ['google_ads|stage:funded', 3],
      ['google_ads|funded_volume', 99000],
    ]);
    const rows = periodRows(input({ source: 'google_ads', frozen }));
    expect(rows.get('spend')!.cell.value).toBe(19000);
    expect(rows.get('funded_deals')!.cell.value).toBe(3);
    expect(rows.get('cpfd')!.cell.value).toBe(19000 / 3);
    // Not frozen: read live.
    expect(rows.get('leads')!.cell.value).toBe(100);
  });

  it('is "—" with its reason where the CRM was not read, never 0', () => {
    const rows = periodRows(input({ crmUnmeasured: 'Salesforce was not read.' }));
    expect(rows.get('funded_deals')!.cell).toMatchObject({ value: null, reason: 'Salesforce was not read.' });
  });
});

describe('compareRows', () => {
  it('colours a rising cost red and rising volume green', () => {
    const a = periodRows(input({ mp: mp(30000, 4, 150000) }));
    const b = periodRows(input({ mp: mp(20000, 4, 120000) }));
    const rows = Object.fromEntries(compareRows(a, b).map((r) => [r.key, r]));
    expect(rows.cpfd).toMatchObject({ assessment: 'shortfall' });
    expect(rows.funded_volume).toMatchObject({ change: 30000, pct: 30000 / 170000, assessment: 'ahead' });
    // Spend declares no direction: its change carries no colour.
    expect(rows.spend!.assessment).toBe('level');
  });
});

describe('lengthNote', () => {
  it('says when the periods differ in length, and nothing when they do not', () => {
    const names = { a: 'September', b: 'August' };
    expect(lengthNote({ start: '2026-09-01', end: '2026-09-30' }, { start: '2026-08-01', end: '2026-08-31' }, names)).toBe(
      'September is 30 days and August is 31: counts and totals cover different lengths of time, so compare rates and costs first.',
    );
    expect(lengthNote({ start: '2026-09-01', end: '2026-09-30' }, { start: '2026-06-01', end: '2026-06-30' }, names)).toBeNull();
  });
});
