import { describe, expect, it } from 'vitest';
import { contractMonthActuals, contractRampTargets, contractTarget, parseContractTargets } from '../src/contract';

/** The signed contract's targets, Zeeraa proposal page 22 (30 October 2026). */
const row = {
  source: 'Zeeraa proposal, page 22',
  cpa: [{ from: '2026-10', value: 1000 }],
  costPerFundedDeal: [{ from: '2026-10', value: 4500 }],
  fundedAmount: [
    { from: '2026-10', low: 100000, high: 150000 },
    { from: '2026-11', value: 200000 },
    { from: '2026-12', value: 400000 },
    { from: '2027-01', value: 750000 },
    { from: '2027-02', value: 1000000 },
    { from: '2027-03', value: 1500000 },
    { from: '2027-04', value: 2000000 },
  ],
};

describe('contract targets', () => {
  const contract = parseContractTargets(row)!;

  it('reads a range, a schedule and an open-ended last entry', () => {
    expect(contractTarget(contract, 'fundedAmount', '2026-10')).toEqual({ low: 100000, high: 150000 });
    expect(contractTarget(contract, 'fundedAmount', '2026-12')).toEqual({ low: 400000, high: null });
    expect(contractTarget(contract, 'fundedAmount', '2027-09')).toEqual({ low: 2000000, high: null });
    expect(contractTarget(contract, 'cpa', '2027-06')).toEqual({ low: 1000, high: null });
  });

  it('has no target before the contract starts', () => {
    expect(contractTarget(contract, 'costPerFundedDeal', '2026-09')).toBeNull();
  });

  it('refuses a malformed row rather than guessing', () => {
    expect(parseContractTargets({ ...row, source: '' })).toBeNull();
    expect(parseContractTargets({ ...row, cpa: [{ from: 'October', value: 1000 }] })).toBeNull();
    expect(parseContractTargets({ ...row, fundedAmount: [{ from: '2026-10' }] })).toBeNull();
  });

  it('lays the contract out by ramp month, each at its low end, with no deal-count target', () => {
    const targets = contractRampTargets(contract, '2026-10', 8);
    expect(targets[0]).toMatchObject({ monthIndex: 1, cpa: 1000, costPerFundedDeal: 4500, fundedAmount: 100000, fundedDeals: null });
    expect(targets[6]).toMatchObject({ monthIndex: 7, fundedAmount: 2000000 });
  });
});

describe('contractMonthActuals', () => {
  const input = {
    adSpend: 45000,
    approvals: 50,
    deals: 10,
    dealsBySource: { google_ads: 4, meta: 2, 'vendor:Popcrumbs': 3 },
    unattributedDeals: 1,
    volumeBySource: { google_ads: 120000, meta: 40000, 'vendor:Popcrumbs': 90000 },
    unattributedVolume: 20000,
    spendRead: true,
    crmRead: true,
  };

  it('divides all ad spend by every source, and counts volume without vendors', () => {
    const a = contractMonthActuals(input, { valueStage: 'funded' });
    expect(a.cpa.value).toBe(900);
    expect(a.costPerFundedDeal.value).toBe(4500);
    expect(a.costPerFundedDeal.cost?.attributedDeals).toBe(10);
    expect(a.fundedAmount.value).toBe(180000);
    expect(a.fundedDeals.value).toBe(7);
  });

  it('is not measured where spend or the CRM was not read, and empty with no deals', () => {
    expect(contractMonthActuals({ ...input, spendRead: false }, { valueStage: 'funded' }).cpa.value).toBeNull();
    expect(contractMonthActuals({ ...input, crmRead: false }, { valueStage: 'funded' }).fundedAmount.value).toBeNull();
    expect(contractMonthActuals({ ...input, deals: 0 }, { valueStage: 'funded' }).costPerFundedDeal).toMatchObject({ value: null, empty: true });
  });
});
