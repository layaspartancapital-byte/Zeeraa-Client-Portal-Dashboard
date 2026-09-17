import { describe, expect, it } from 'vitest';
import {
  attributionCoverage,
  channelCostPerDeal,
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

describe('channelCostPerDeal', () => {
  it("divides a channel's spend by the deals attributed to that channel", () => {
    expect(channelCostPerDeal({ channelSpend: 45_000, attributedDeals: 10 }).value).toBe(4_500);
  });

  it('never folds unattributed deals into the denominator', () => {
    // The mistake this guards against: 21 deals funded in the period, 6 of them
    // attributed to this channel, the other 15 from organic, referral, outbound
    // and repeat business. Dividing by 21 would make the channel look four
    // times cheaper than it is, and would improve every time the sales team had
    // a good month.
    const result = channelCostPerDeal({
      channelSpend: 78_873.97,
      attributedDeals: 6,
      unattributedDeals: 15,
    });
    expect(result.attributedDeals).toBe(6);
    expect(result.unattributedDeals).toBe(15);
    expect(result.value).toBeCloseTo(13_145.66, 2);
    // Not 78_873.97 / 21.
    expect(result.value).not.toBeCloseTo(3_755.90, 2);
  });

  it('brackets the figure by what the unattributed deals could do to it', () => {
    const result = channelCostPerDeal({
      channelSpend: 78_873.97,
      attributedDeals: 6,
      unattributedDeals: 15,
    });
    // High: none of the unattributed deals belong to this channel — the
    // confirmed figure. Low: every one of them does, the most generous reading
    // the data permits. The truth is inside, and usually at neither end.
    expect(result.plausibleRange.high).toBe(result.value);
    expect(result.plausibleRange.low).toBeCloseTo(3_755.90, 2);
  });

  it('keeps deals attributed elsewhere out of the range entirely', () => {
    // Somebody else's deal is not uncertainty about ours: it can never move
    // this channel's figure, so it is neither a denominator nor a bound.
    const result = channelCostPerDeal({
      channelSpend: 10_000,
      attributedDeals: 2,
      unattributedDeals: 0,
      dealsAttributedElsewhere: 8,
    });
    expect(result.value).toBe(5_000);
    expect(result.dealsAttributedElsewhere).toBe(8);
    expect(result.plausibleRange.low).toBe(5_000);
    expect(result.plausibleRange.high).toBe(5_000);
  });

  it('returns null with no attributed deals, not zero and not infinity', () => {
    const result = channelCostPerDeal({ channelSpend: 12_000, attributedDeals: 0 });
    expect(result.value).toBeNull();
    expect(result.plausibleRange.high).toBeNull();
    expect(result.channelSpend).toBe(12_000);
  });

  it('still brackets when nothing is attributed but deals exist', () => {
    // Spend, deals, and no link between them. There is no cost per deal to
    // report, but the range still says what it could be at best.
    const result = channelCostPerDeal({
      channelSpend: 12_000,
      attributedDeals: 0,
      unattributedDeals: 4,
    });
    expect(result.value).toBeNull();
    expect(result.plausibleRange.low).toBe(3_000);
    expect(result.plausibleRange.high).toBeNull();
  });

  it('costPerFundedDeal is the same metric on the value stage', () => {
    const input = { channelSpend: 9_000, attributedDeals: 3, unattributedDeals: 6 };
    expect(costPerFundedDeal(input)).toEqual(channelCostPerDeal(input));
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
