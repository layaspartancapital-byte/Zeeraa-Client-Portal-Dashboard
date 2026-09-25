import { describe, expect, it } from 'vitest';
import { assembleFundedDeals, type FundedDealInputs } from '../src/lib/funded-deals';

const base = (over: Partial<FundedDealInputs> = {}): FundedDealInputs => ({
  platform: 'google_ads',
  credited: new Set(['A', 'B']),
  events: [
    { opportunityId: 'A', occurredOn: '2026-09-10' },
    { opportunityId: 'A', occurredOn: '2026-09-03' },
    { opportunityId: 'B', occurredOn: '2026-09-12' },
    // Funded in range but credited elsewhere: not this page's deal.
    { opportunityId: 'C', occurredOn: '2026-09-11' },
  ],
  campaigns: new Map([['A', 'Direct Lender']]),
  opportunities: new Map([
    ['A', { name: 'Acme Bakery', fundedAmount: 50_000 }],
    ['B', { name: null, fundedAmount: null }],
    ['C', { name: 'Elsewhere', fundedAmount: 1 }],
  ]),
  leads: [
    { opportunityId: 'A', channel: 'google_ads', createdAt: new Date('2026-08-02'), detail: 'business loans' },
    { opportunityId: 'A', channel: 'google_ads', createdAt: new Date('2026-08-01'), detail: 'small business loans' },
    // B's lead came from Meta: its utm_term says nothing about a Google keyword.
    { opportunityId: 'B', channel: 'meta', createdAt: new Date('2026-08-01'), detail: 'adset-1' },
  ],
  ...over,
});

describe('assembleFundedDeals', () => {
  it('has exactly one row per deal the page counts', () => {
    const rows = assembleFundedDeals(base());
    expect(rows.map((r) => r.opportunityId).sort()).toEqual(['A', 'B']);
  });

  it('dates a deal by its first funding in range and sorts newest first', () => {
    expect(assembleFundedDeals(base()).map((r) => [r.opportunityId, r.fundedOn])).toEqual([
      ['B', '2026-09-12'],
      ['A', '2026-09-03'],
    ]);
  });

  it('takes every detail from a source, and null where none recorded it', () => {
    const [b, a] = assembleFundedDeals(base());
    expect(a).toMatchObject({ name: 'Acme Bakery', fundedAmount: 50_000, campaign: 'Direct Lender', detail: 'small business loans' });
    expect(b).toMatchObject({ name: null, fundedAmount: null, campaign: null, detail: null });
  });

  it('names a Meta ad where its name was read, and keeps the id where not', () => {
    const rows = assembleFundedDeals(
      base({
        platform: 'meta',
        credited: new Set(['A', 'B']),
        leads: [
          { opportunityId: 'A', channel: 'meta', createdAt: new Date('2026-08-01'), detail: '111' },
          { opportunityId: 'B', channel: 'meta', createdAt: new Date('2026-08-01'), detail: '222' },
        ],
        adNames: new Map([['111', 'SCG Submit']]),
      }),
    );
    expect(Object.fromEntries(rows.map((r) => [r.opportunityId, r.detail]))).toEqual({ A: 'SCG Submit', B: '222' });
  });
});
