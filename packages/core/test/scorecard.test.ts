import { describe, expect, it } from 'vitest';
import { scorecardVerdict } from '../src/scorecard';
import type { PopulationVerdict } from '../src/population';

const base = {
  actualReason: null,
  noTarget: null,
  partial: false,
  elapsed: 1,
} as const;

const gate = (sufficient: boolean): PopulationVerdict =>
  ({ sufficient, population: 2, minimum: 5, noun: 'deals', reason: sufficient ? null : 'Fewer than 5 deals.' }) as PopulationVerdict;

describe('scorecardVerdict', () => {
  it('reads a cost above its target as behind, by the distance', () => {
    expect(
      scorecardVerdict({ ...base, actual: 5000, target: 4000, direction: 'down', kind: 'rate' }),
    ).toEqual({ state: 'behind', by: 1000, paced: false });
  });

  it('reads a cost below its target as on target, not as a celebration', () => {
    expect(
      scorecardVerdict({ ...base, actual: 3000, target: 4000, direction: 'down', kind: 'rate' }),
    ).toEqual({ state: 'on_target', paced: false });
  });

  it('treats five per cent either side as on target', () => {
    expect(
      scorecardVerdict({ ...base, actual: 4150, target: 4000, direction: 'down', kind: 'rate' }).state,
    ).toBe('on_target');
  });

  it('judges a partial month of a count against pace, not the whole month', () => {
    // 10 contracted, 60% of the month gone: 6 is on pace, 3 is 3 behind it.
    const at = (actual: number) =>
      scorecardVerdict({ ...base, actual, target: 10, direction: 'up', kind: 'count', partial: true, elapsed: 0.6 });
    expect(at(6)).toEqual({ state: 'on_target', paced: true });
    const behind = at(3);
    expect(behind.state).toBe('behind');
    expect(behind.state === 'behind' && behind.by).toBeCloseTo(3);
  });

  it('does not pro-rate a cost, which is already per deal', () => {
    expect(
      scorecardVerdict({ ...base, actual: 4000, target: 4000, direction: 'down', kind: 'rate', partial: true, elapsed: 0.5 }),
    ).toEqual({ state: 'on_target', paced: false });
  });

  it('withholds a count early in the month and a rate below its comparison floor', () => {
    expect(
      scorecardVerdict({ ...base, actual: 1, target: 10, direction: 'up', kind: 'count', partial: true, elapsed: 0.1 }).state,
    ).toBe('too_early');
    expect(
      scorecardVerdict({ ...base, actual: 9000, target: 4000, direction: 'down', kind: 'rate', comparable: gate(false) }),
    ).toEqual({ state: 'too_early', reason: 'Fewer than 5 deals.' });
  });

  it('states spend as over or under, never behind', () => {
    expect(
      scorecardVerdict({ ...base, actual: 36000, target: 30000, direction: null, kind: 'count' }),
    ).toEqual({ state: 'over', by: 6000, paced: false });
    expect(
      scorecardVerdict({ ...base, actual: 20000, target: 30000, direction: null, kind: 'count' }),
    ).toEqual({ state: 'under', by: 10000, paced: false });
  });

  it('says why where there is no target or no figure, and never computes a gap', () => {
    expect(
      scorecardVerdict({ ...base, actual: 5, target: null, noTarget: 'Targets begin Oct 2026', direction: 'up', kind: 'count' }),
    ).toEqual({ state: 'no_target', reason: 'Targets begin Oct 2026' });
    expect(
      scorecardVerdict({ ...base, actual: null, actualReason: 'Not read.', target: 10, direction: 'up', kind: 'count' }),
    ).toEqual({ state: 'not_measured', reason: 'Not read.' });
  });
});
