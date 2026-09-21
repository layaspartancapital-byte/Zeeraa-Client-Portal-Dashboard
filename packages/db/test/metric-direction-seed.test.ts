import { describe, expect, it } from 'vitest';
import { improvementDirectionFor, looksLikeCost } from '@zeeraa/core';
import { spartan } from '../seeds/spartan';

/**
 * A seeded `improvement_direction` must agree with the metric's definition.
 *
 * `@zeeraa/core` decides the direction from `formula_key` and the row is only
 * consulted for a formula core has never heard of, so a row that disagreed
 * would not miscolour anything — it would simply be ignored, which is worse in
 * its own way: the configuration would say one thing and the product would do
 * another, and the next person to read the seed would believe the seed.
 */
describe('seeded metric directions', () => {
  const metrics = spartan.metrics;

  it('has metrics to check, so this test cannot pass vacuously', () => {
    expect(metrics.length).toBeGreaterThan(5);
  });

  it('agrees with the direction each formula declares', () => {
    const disagreements = metrics
      .map((metric) => {
        const declared = improvementDirectionFor(metric.formulaKey);
        if (declared === null || declared === metric.improvementDirection) return null;
        return `${metric.key} (formula ${metric.formulaKey}): seed says ${metric.improvementDirection}, core says ${declared}`;
      })
      .filter(Boolean);
    expect(disagreements).toEqual([]);
  });

  it('never seeds a cost metric as higher-is-better', () => {
    for (const metric of metrics) {
      if (looksLikeCost(metric.formulaKey) || looksLikeCost(metric.key)) {
        expect(metric.improvementDirection, `${metric.key} is a cost metric`).toBe('down');
      }
    }
  });

  it('covers the cost metrics this engagement actually reports', () => {
    // Named rather than inferred: if one of these ever disappears from the seed
    // the test should fail rather than quietly check nothing.
    for (const key of ['cost_per_funded_deal', 'cpa', 'total_program_cost']) {
      const metric = metrics.find((m) => m.key === key);
      expect(metric, `${key} is missing from the seed`).toBeDefined();
      expect(improvementDirectionFor(metric!.formulaKey)).toBe('down');
    }
  });
});
