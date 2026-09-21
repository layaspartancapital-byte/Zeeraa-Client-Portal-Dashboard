import { describe, expect, it } from 'vitest';
import { delta, improvementDirectionFor } from '@zeeraa/core';
import { toneFor } from '../src/components/ui/delta-tone';

/**
 * The last link: metric definition → assessment → colour on screen.
 *
 * `improvementDirectionFor` and `delta` are tested in core, but neither knows
 * what colour anything ends up. This asserts the join, on the metrics whose
 * direction is most often assumed the wrong way round.
 */
const toneOf = (formula: string, current: number, baseline: number) => {
  const direction = improvementDirectionFor(formula);
  const d = delta(current, baseline, direction ?? 'up');
  return toneFor(direction === null ? 'level' : d.assessment);
};

describe('what a change is coloured', () => {
  it('shows a rising cost per funded deal in red', () => {
    expect(toneOf('cost_per_funded_deal', 9000, 8000)).toBe('text-down-text');
  });

  it('shows a falling cost per funded deal in green', () => {
    expect(toneOf('cost_per_funded_deal', 7000, 8000)).toBe('text-up-text');
  });

  it('does the same for every other cost metric', () => {
    for (const formula of ['cost_per_stage', 'cost_per_conversion', 'cpc', 'cpm', 'cpa']) {
      expect(toneOf(formula, 110, 100), `${formula} rising`).toBe('text-down-text');
      expect(toneOf(formula, 90, 100), `${formula} falling`).toBe('text-up-text');
    }
  });

  it('keeps rates the other way up', () => {
    for (const formula of ['stage_conversion_rate', 'ctr', 'conversion_rate', 'qualified_rate']) {
      expect(toneOf(formula, 0.2, 0.1), `${formula} rising`).toBe('text-up-text');
      expect(toneOf(formula, 0.05, 0.1), `${formula} falling`).toBe('text-down-text');
    }
  });

  it('colours spend neither way, in either direction', () => {
    expect(toneOf('paid_media_spend', 120, 100)).toBe('text-text-2');
    expect(toneOf('paid_media_spend', 80, 100)).toBe('text-text-2');
  });

  it('colours an undeclared cost metric as a cost, not as a win', () => {
    expect(toneOf('cost_per_mql', 110, 100)).toBe('text-down-text');
  });

  it('makes no claim about a metric nothing declares', () => {
    expect(toneOf('some_new_thing', 110, 100)).toBe('text-text-2');
  });
});
