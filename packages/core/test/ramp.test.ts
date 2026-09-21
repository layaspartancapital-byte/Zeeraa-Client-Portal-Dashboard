import { describe, expect, it } from 'vitest';
import {
  gapToTarget,
  monthKeyOf,
  rampMonthIndex,
  rampMonthKey,
  seriesTrend,
  targetForMonth,
  type RampTarget,
} from '../src/ramp';

/** The eight CPF figures Zeeraa's engagement model states. */
const RAMP: RampTarget[] = [
  4000, 3680, 3496, 3321, 3155, 2997, 2848, 2705,
].map((costPerFundedDeal, i) => ({
  monthIndex: i + 1,
  costPerFundedDeal,
  budget: i === 0 ? 30000 : null,
  cpa: null,
  approvals: null,
  fundedDeals: null,
}));

describe('rampMonthIndex', () => {
  it('counts the first month as M1, not M0', () => {
    expect(rampMonthIndex('2026-10', '2026-10')).toBe(1);
  });

  it('counts across a year boundary', () => {
    expect(rampMonthIndex('2026-10', '2026-11')).toBe(2);
    expect(rampMonthIndex('2026-10', '2026-12')).toBe(3);
    expect(rampMonthIndex('2026-10', '2027-01')).toBe(4);
    expect(rampMonthIndex('2026-10', '2027-05')).toBe(8);
  });

  it('returns null before the engagement started', () => {
    expect(rampMonthIndex('2026-10', '2026-09')).toBeNull();
    expect(rampMonthIndex('2026-10', '2025-12')).toBeNull();
  });

  it('keeps counting past the end of the ramp rather than stopping', () => {
    // "Month 9 of an eight-month ramp" is a real answer; the caller decides
    // there is no target for it. Returning null here would be indistinguishable
    // from "before we started", and a chart would draw M8 forever.
    expect(rampMonthIndex('2026-10', '2027-06')).toBe(9);
    expect(rampMonthIndex('2026-10', '2028-10')).toBe(25);
  });

  it('refuses anything that is not a month key', () => {
    expect(rampMonthIndex('2026-10-01', '2026-10')).toBeNull();
    expect(rampMonthIndex('2026-13', '2026-10')).toBeNull();
    expect(rampMonthIndex('2026-10', 'October')).toBeNull();
  });
});

describe('rampMonthKey', () => {
  it('is the inverse of rampMonthIndex', () => {
    for (let i = 1; i <= 24; i += 1) {
      const month = rampMonthKey('2026-10', i)!;
      expect(rampMonthIndex('2026-10', month)).toBe(i);
    }
  });

  it('rolls the year over correctly', () => {
    expect(rampMonthKey('2026-10', 1)).toBe('2026-10');
    expect(rampMonthKey('2026-10', 3)).toBe('2026-12');
    expect(rampMonthKey('2026-10', 4)).toBe('2027-01');
    expect(rampMonthKey('2026-12', 2)).toBe('2027-01');
    expect(rampMonthKey('2026-01', 12)).toBe('2026-12');
    expect(rampMonthKey('2026-01', 13)).toBe('2027-01');
  });
});

describe('targetForMonth', () => {
  it('has no target at all until a start month is recorded', () => {
    // The state the product is in today, and the reason the chart says the
    // ramp begins when the engagement does rather than assuming a month.
    for (const month of ['2026-09', '2026-10', '2027-01']) {
      expect(targetForMonth(RAMP, null, month)).toBeNull();
    }
  });

  it('maps M1 onto the start month once it is set', () => {
    expect(targetForMonth(RAMP, '2026-10', '2026-10')?.costPerFundedDeal).toBe(4000);
    expect(targetForMonth(RAMP, '2026-10', '2026-11')?.costPerFundedDeal).toBe(3680);
    expect(targetForMonth(RAMP, '2026-10', '2027-05')?.costPerFundedDeal).toBe(2705);
  });

  it('moves the whole curve when the start month moves', () => {
    expect(targetForMonth(RAMP, '2027-01', '2027-01')?.costPerFundedDeal).toBe(4000);
    expect(targetForMonth(RAMP, '2027-01', '2026-10')).toBeNull();
  });

  it('gives no target before the start or past the end', () => {
    expect(targetForMonth(RAMP, '2026-10', '2026-09')).toBeNull();
    expect(targetForMonth(RAMP, '2026-10', '2027-06')).toBeNull();
  });
});

describe('gapToTarget', () => {
  it('reads a cost above target as a shortfall', () => {
    const gap = gapToTarget(8763, 4000, 'down');
    expect(gap.absolute).toBe(4763);
    expect(gap.assessment).toBe('shortfall');
    expect(gap.relative).toBeCloseTo(1.19075, 4);
  });

  it('reads a cost below target as ahead', () => {
    const gap = gapToTarget(3200, 4000, 'down');
    expect(gap.absolute).toBe(-800);
    expect(gap.assessment).toBe('ahead');
  });

  it('reads exactly on target as level', () => {
    expect(gapToTarget(4000, 4000, 'down').assessment).toBe('level');
  });

  it('runs the other way for a metric that is better higher', () => {
    expect(gapToTarget(12, 10, 'up').assessment).toBe('ahead');
    expect(gapToTarget(8, 10, 'up').assessment).toBe('shortfall');
  });
});

describe('seriesTrend', () => {
  it('calls a falling cost an improvement', () => {
    expect(seriesTrend([9000, 8500, 8000], 'down')).toBe('ahead');
  });

  it('calls a rising cost a regression', () => {
    expect(seriesTrend([8000, 8500, 9000], 'down')).toBe('shortfall');
  });

  it('reads first against last, not the noise between', () => {
    // Down overall despite a spike in the middle.
    expect(seriesTrend([9000, 12000, 8000], 'down')).toBe('ahead');
  });

  it('skips gaps rather than treating them as zero', () => {
    expect(seriesTrend([null, 9000, null, 8000, null], 'down')).toBe('ahead');
  });

  it('makes no claim from a single point, or from none', () => {
    expect(seriesTrend([8000], 'down')).toBe('level');
    expect(seriesTrend([], 'down')).toBe('level');
    expect(seriesTrend([null, null], 'down')).toBe('level');
  });

  it('makes no claim when the metric declares no direction', () => {
    expect(seriesTrend([100, 900], null)).toBe('level');
  });
});

describe('monthKeyOf', () => {
  it('takes the month a tenant-local day falls in', () => {
    expect(monthKeyOf('2026-09-21')).toBe('2026-09');
  });
});
