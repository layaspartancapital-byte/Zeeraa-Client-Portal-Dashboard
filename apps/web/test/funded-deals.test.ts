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
    { opportunityId: 'A', channel: 'google_ads', createdAt: new Date('2026-08-02'), detail: 'business loans', campaignTag: null },
    { opportunityId: 'A', channel: 'google_ads', createdAt: new Date('2026-08-01'), detail: 'small business loans', campaignTag: null },
    // B's lead came from Meta: its utm_term says nothing about a Google keyword.
    { opportunityId: 'B', channel: 'meta', createdAt: new Date('2026-08-01'), detail: 'adset-1', campaignTag: '120248746573590176' },
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
    expect(a).toMatchObject({ name: 'Acme Bakery', fundedAmount: 50_000, campaign: 'Direct Lender', campaignFromTag: false, detail: 'small business loans' });
    // B's lead is Meta's, so its utm_campaign is not a Google campaign either.
    expect(b).toMatchObject({ name: null, fundedAmount: null, campaign: null, campaignFromTag: false, detail: null });
  });

  it('names a Meta ad where its name was read, and keeps the id where not', () => {
    const rows = assembleFundedDeals(
      base({
        platform: 'meta',
        credited: new Set(['A', 'B']),
        leads: [
          { opportunityId: 'A', channel: 'meta', createdAt: new Date('2026-08-01'), detail: '111', campaignTag: null },
          { opportunityId: 'B', channel: 'meta', createdAt: new Date('2026-08-01'), detail: '222', campaignTag: null },
        ],
        adNames: new Map([['111', 'SCG Submit']]),
      }),
    );
    expect(Object.fromEntries(rows.map((r) => [r.opportunityId, r.detail]))).toEqual({ A: 'SCG Submit', B: '222' });
  });

  describe('the URL-tag fallback for the campaign', () => {
    const meta = (campaignTag: string | null, credited: string | null = null) =>
      assembleFundedDeals(
        base({
          platform: 'meta',
          credited: new Set(['A']),
          campaigns: new Map([['A', credited]]),
          leads: [{ opportunityId: 'A', channel: 'meta', createdAt: new Date('2026-08-01'), detail: null, campaignTag }],
          campaignNamesById: new Map([['120248746573590176', 'SCG_Meta_SubmitApp_v1']]),
        }),
      )[0]!;

    it('names a tag that is exactly an ingested campaign id, and marks it', () => {
      expect(meta('120248746573590176')).toMatchObject({ campaign: 'SCG_Meta_SubmitApp_v1', campaignFromTag: true });
    });

    it('shows any other tag as recorded — never matched by prefix', () => {
      expect(meta('C1_Conversion_Apply-')).toMatchObject({ campaign: 'C1_Conversion_Apply-', campaignFromTag: true });
      expect(meta('12024874657359')).toMatchObject({ campaign: '12024874657359', campaignFromTag: true });
    });

    it('never replaces a campaign attribution credits', () => {
      expect(meta('120248746573590176', 'Credited')).toMatchObject({ campaign: 'Credited', campaignFromTag: false });
    });

    it('leaves it Not recorded with no tag', () => {
      expect(meta(null)).toMatchObject({ campaign: null, campaignFromTag: false });
      expect(meta('  ')).toMatchObject({ campaign: null, campaignFromTag: false });
    });
  });
});
