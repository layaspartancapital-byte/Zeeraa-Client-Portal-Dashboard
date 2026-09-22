import { describe, expect, it } from 'vitest';
import {
  PACING_CONFIDENCE_ELAPSED,
  budgetPacing,
  improvementDirectionFor,
  pacingState,
} from '../src';

describe('budgetPacing', () => {
  it('projects where the month lands at the current rate', () => {
    // Half the month gone, half the budget spent: lands exactly on it.
    const pacing = budgetPacing({ spent: 15_000, budget: 30_000, elapsed: 0.5 })!;
    expect(pacing.projected).toBe(30_000);
    expect(pacing.variance).toBe(0);
    expect(pacingState(pacing)).toBe('on_plan');
  });

  it('reports a month running hot as over, with the variance in money', () => {
    const pacing = budgetPacing({ spent: 20_000, budget: 30_000, elapsed: 0.5 })!;
    expect(pacing.projected).toBe(40_000);
    expect(pacing.variance).toBe(10_000);
    expect(pacingState(pacing)).toBe('over');
  });

  it('treats a small drift as on plan rather than crying wolf every month', () => {
    // 2% hot. Nothing lands exactly on its budget, and a card that says "over"
    // at 0.4% is a card nobody reads by March.
    const pacing = budgetPacing({ spent: 15_300, budget: 30_000, elapsed: 0.5 })!;
    expect(pacingState(pacing)).toBe('on_plan');
    expect(pacing.variance).toBeCloseTo(600, 6);
  });

  it('marks an early projection as unconfident rather than withholding it', () => {
    // Day three of thirty. The projection is correct and volatile; the screen
    // needs to know which, and the reader still needs a number.
    const early = budgetPacing({ spent: 4_000, budget: 30_000, elapsed: 0.1 })!;
    expect(early.projected).toBe(40_000);
    expect(early.confident).toBe(false);

    const late = budgetPacing({ spent: 20_000, budget: 30_000, elapsed: 0.7 })!;
    expect(late.confident).toBe(true);
    expect(PACING_CONFIDENCE_ELAPSED).toBeGreaterThan(0);
  });

  it('has no projection on day zero rather than dividing by nothing', () => {
    const pacing = budgetPacing({ spent: 0, budget: 30_000, elapsed: 0 })!;
    expect(pacing.projected).toBeNull();
    expect(pacing.variance).toBeNull();
    expect(pacingState(pacing)).toBe('on_plan');
  });

  it('returns null for an absent budget, which is not a budget of zero', () => {
    // The screen has to say the budget is unrecorded. A bar drawn against zero
    // is a bar at infinity.
    expect(budgetPacing({ spent: 5_000, budget: 0, elapsed: 0.5 })).toBeNull();
    expect(budgetPacing({ spent: 5_000, budget: Number.NaN, elapsed: 0.5 })).toBeNull();
  });

  it('reports drift as the gap between spend and calendar', () => {
    const pacing = budgetPacing({ spent: 24_000, budget: 30_000, elapsed: 0.5 })!;
    expect(pacing.spentShare).toBeCloseTo(0.8, 6);
    expect(pacing.drift).toBeCloseTo(0.3, 6);
  });

  it('declares no improvement direction for spend', () => {
    // Overspending is not a failure and underspending is not thrift. What the
    // spend bought decides that, and cost per stage is the metric that answers
    // it.
    expect(improvementDirectionFor('paid_media_spend')).toBeNull();
  });
});
