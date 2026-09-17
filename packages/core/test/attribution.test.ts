import { describe, expect, it } from 'vitest';
import {
  attributionCoverage,
  costPerFundedDeal,
  resolveAttribution,
  resolveBothModels,
  type AttributionTouch,
} from '../src/attribution';

const touch = (clickId: string, occurredOn: string, campaignId: string | null = 'c1'): AttributionTouch => ({
  clickId,
  platform: 'google_ads',
  campaignId,
  occurredOn,
});

describe('resolveAttribution', () => {
  it('picks the earliest touch for first touch and the latest for last', () => {
    const touches = [touch('b', '2026-08-02'), touch('a', '2026-07-01'), touch('c', '2026-09-03')];
    expect(resolveAttribution(touches, 'first_touch').touch?.clickId).toBe('a');
    expect(resolveAttribution(touches, 'last_touch').touch?.clickId).toBe('c');
  });

  it('is stable when two clicks fall on the same day', () => {
    // click_view reports a date and no time, so same-day touches are genuinely
    // unordered. Without a deterministic tiebreak the same data would attribute
    // differently on each run depending on row order.
    const forward = [touch('zebra', '2026-08-02'), touch('alpha', '2026-08-02')];
    const reversed = [...forward].reverse();
    expect(resolveAttribution(forward, 'first_touch').touch?.clickId).toBe('alpha');
    expect(resolveAttribution(reversed, 'first_touch').touch?.clickId).toBe('alpha');
    expect(resolveAttribution(forward, 'last_touch').touch?.clickId).toBe('zebra');
    expect(resolveAttribution(reversed, 'last_touch').touch?.clickId).toBe('zebra');
  });

  it('reports no touches distinctly from an unresolvable campaign', () => {
    // A deal with no click never came from paid. A deal whose click aged out of
    // the platform's window came from paid and can no longer be proven to.
    expect(resolveAttribution([], 'last_touch')).toMatchObject({
      touch: null,
      unattributedReason: 'no_touches',
    });
    expect(resolveAttribution([touch('a', '2026-08-02', null)], 'last_touch')).toMatchObject({
      unattributedReason: 'no_campaign_resolved',
    });
  });

  it('keeps an unresolvable touch in the ordering rather than dropping it', () => {
    // Dropping it would silently promote another click into a position it did
    // not hold, which is quieter than reporting the deal as unattributed.
    const touches = [touch('known', '2026-07-01'), touch('expired', '2026-09-03', null)];
    const last = resolveAttribution(touches, 'last_touch');
    expect(last.touch?.clickId).toBe('expired');
    expect(last.unattributedReason).toBe('no_campaign_resolved');
  });

  it('resolves both models together, as §4 requires them stored', () => {
    const both = resolveBothModels([touch('a', '2026-07-01'), touch('b', '2026-09-03')]);
    expect(both.first_touch.touch?.clickId).toBe('a');
    expect(both.last_touch.touch?.clickId).toBe('b');
  });
});

describe('costPerFundedDeal', () => {
  it('divides attributed spend by funded deals', () => {
    expect(costPerFundedDeal({ attributedSpend: 45_000, fundedDeals: 10 }).value).toBe(4_500);
  });

  it('returns null with no funded deals, not zero and not infinity', () => {
    // Spend with no funded deals has no cost per deal. The UI renders an
    // explicit empty state rather than a number.
    const result = costPerFundedDeal({ attributedSpend: 12_000, fundedDeals: 0 });
    expect(result.value).toBeNull();
    expect(result.spend).toBe(12_000);
  });

  it('carries the unattributed shares rather than folding them in', () => {
    // A cost per deal over attributed spend alone flatters itself; one over all
    // spend while counting only attributed deals does the opposite.
    const result = costPerFundedDeal({
      attributedSpend: 30_000,
      unattributedSpend: 20_000,
      fundedDeals: 6,
      unattributedFundedDeals: 4,
    });
    expect(result.value).toBe(5_000);
    expect(result.unattributedSpend).toBe(20_000);
    expect(result.unattributedFundedDeals).toBe(4);
  });
});

describe('attributionCoverage', () => {
  it('splits unattributed deals by why', () => {
    const coverage = attributionCoverage([
      resolveAttribution([touch('a', '2026-08-01')], 'last_touch'),
      resolveAttribution([touch('b', '2026-08-01', null)], 'last_touch'),
      resolveAttribution([], 'last_touch'),
      resolveAttribution([], 'last_touch'),
    ]);
    expect(coverage).toEqual({
      total: 4,
      attributed: 1,
      noTouches: 2,
      clickWithoutCampaign: 1,
      rate: 0.25,
    });
  });

  it('returns a null rate with nothing to describe, not a zero rate', () => {
    expect(attributionCoverage([]).rate).toBeNull();
  });
});
