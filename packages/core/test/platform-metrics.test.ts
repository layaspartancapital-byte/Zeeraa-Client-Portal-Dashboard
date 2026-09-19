import { describe, expect, it } from 'vitest';
import {
  breakdownCoverage,
  conversionRate,
  costPerConversion,
  cpc,
  cpm,
  ctr,
  frequency,
  linkClickShare,
  weightedPosition,
} from '../src/platform-metrics';

describe('an empty denominator has no rate', () => {
  it.each([
    ['ctr', () => ctr(5, 0)],
    ['cpc', () => cpc(100, 0)],
    ['cpm', () => cpm(100, 0)],
    ['conversionRate', () => conversionRate(3, 0)],
    ['costPerConversion', () => costPerConversion(100, 0)],
    ['frequency', () => frequency(100, 0)],
  ])('%s returns null rather than zero or infinity', (_name, fn) => {
    expect(fn()).toBeNull();
  });

  it('never returns Infinity, which would render as a number', () => {
    // 100 / 0 is Infinity in JavaScript and formats as "∞" — a figure a client
    // would reasonably read as a real cost.
    expect(cpc(100, 0)).not.toBe(Infinity);
    expect(costPerConversion(100, 0)).not.toBe(Infinity);
  });
});

describe('an empty numerator over a real denominator is a measurement', () => {
  it('reports a conversion rate of zero when clicks happened and converted none', () => {
    expect(conversionRate(0, 500)).toBe(0);
  });

  it('reports a CTR of zero when an ad was served and never clicked', () => {
    expect(ctr(0, 1000)).toBe(0);
  });
});

describe('the rates themselves', () => {
  it('computes CTR', () => {
    expect(ctr(61, 1363)).toBeCloseTo(0.04475, 5);
  });

  it('computes CPC', () => {
    expect(cpc(147.33, 61)).toBeCloseTo(2.4152, 4);
  });

  it('computes CPM per thousand impressions, not per impression', () => {
    expect(cpm(147.33, 1363)).toBeCloseTo(108.09, 2);
  });

  it('computes cost per conversion', () => {
    expect(costPerConversion(147.33, 9)).toBeCloseTo(16.37, 2);
  });
});

describe('reach-derived figures', () => {
  it('computes frequency as impressions per person', () => {
    expect(frequency(1363, 900)).toBeCloseTo(1.514, 3);
  });

  it('has no frequency where the platform does not report reach', () => {
    // Google Ads. Null is "not reported", which is not the same as one
    // impression per person.
    expect(frequency(61834, null)).toBeNull();
  });
});

describe('the link-click distinction', () => {
  it('is a share where the platform separates the two', () => {
    expect(linkClickShare(5143, 8088)).toBeCloseTo(0.6359, 4);
  });

  it('is null where the platform makes no distinction', () => {
    // Google Ads reports one click figure. That is an absence of the
    // distinction, not every click being a link click.
    expect(linkClickShare(3648, null)).toBeNull();
    expect(linkClickShare(3648, null)).not.toBe(1);
  });
});

describe('weightedPosition', () => {
  it('weights by impressions, not by row', () => {
    // The plain mean is 9.6; the honest answer is dominated by the day that was
    // actually seen three thousand times.
    const rows = [
      { position: 1.2, impressions: 3 },
      { position: 18, impressions: 3000 },
    ];
    expect(weightedPosition(rows)).toBeCloseTo(17.983, 3);
    const plainMean = (1.2 + 18) / 2;
    expect(weightedPosition(rows)).not.toBeCloseTo(plainMean, 1);
  });

  it('skips a row with no impressions rather than counting it as position zero', () => {
    const rows = [
      { position: 4, impressions: 100 },
      { position: 1, impressions: 0 },
    ];
    expect(weightedPosition(rows)).toBe(4);
  });

  it('has no average where nothing was impressed', () => {
    // Position 0 does not exist — the scale starts at 1 — so an absence is null.
    expect(weightedPosition([{ position: 3, impressions: 0 }])).toBeNull();
    expect(weightedPosition([])).toBeNull();
  });

  it('ignores a row whose position the API did not report', () => {
    expect(weightedPosition([{ position: null, impressions: 500 }, { position: 2, impressions: 500 }])).toBe(2);
  });
});

describe('breakdownCoverage', () => {
  it('states what share of the total the visible rows account for', () => {
    expect(breakdownCoverage(820, 1000)).toBeCloseTo(0.82, 4);
  });

  it('is null against an empty total rather than zero', () => {
    expect(breakdownCoverage(0, 0)).toBeNull();
  });
});
