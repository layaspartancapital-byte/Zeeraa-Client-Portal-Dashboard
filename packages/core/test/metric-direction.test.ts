import { describe, expect, it } from 'vitest';
import {
  declaredFormulas,
  improvementDirectionFor,
  looksLikeCost,
} from '../src/metric-direction';
import { delta } from '../src/format';

describe('improvementDirectionFor', () => {
  it('calls every cost metric lower-is-better', () => {
    for (const formula of [
      'cost_per_funded_deal',
      'cost_per_stage',
      'cost_per_conversion',
      'total_program_cost',
      'cpc',
      'cpm',
      'cpa',
    ]) {
      expect(improvementDirectionFor(formula)).toBe('down');
    }
  });

  it('keeps rates higher-is-better', () => {
    for (const formula of [
      'stage_conversion_rate',
      'submission_offer_rate',
      'qualified_rate',
      'ctr',
      'conversion_rate',
      'attributed_share',
    ]) {
      expect(improvementDirectionFor(formula)).toBe('up');
    }
  });

  it('does not treat "rate" as a rule — waste and rework fall', () => {
    expect(improvementDirectionFor('duplicate_rate')).toBe('down');
    expect(improvementDirectionFor('resubmission_rate')).toBe('down');
  });

  it('reports time taken as lower-is-better', () => {
    expect(improvementDirectionFor('stage_velocity')).toBe('down');
  });

  it('declares spend neutral, and will not let a config row colour it', () => {
    expect(improvementDirectionFor('paid_media_spend')).toBeNull();
    expect(improvementDirectionFor('paid_media_spend', 'up')).toBeNull();
    expect(improvementDirectionFor('paid_media_spend', 'down')).toBeNull();
  });

  /**
   * The property this module exists for. Anything undeclared may be neutral,
   * and an undeclared cost must be `down`, but nothing may default to `up` —
   * that is the one answer that paints a rising cost green.
   */
  it('never defaults an undeclared formula to up', () => {
    const invented = [
      'cost_per_mql',
      'cost_per_application',
      'blended_cost_per_deal',
      'cpl',
      'cac',
      'media_cost',
      'spend_per_lead',
      'something_nobody_declared',
      '',
    ];
    for (const formula of invented) {
      expect(improvementDirectionFor(formula)).not.toBe('up');
    }
  });

  it('infers down for an undeclared cost metric', () => {
    expect(improvementDirectionFor('cost_per_mql')).toBe('down');
    expect(improvementDirectionFor('cac')).toBe('down');
    expect(improvementDirectionFor('media_cost')).toBe('down');
    // Even when a config row insists otherwise — the formula wins.
    expect(improvementDirectionFor('cost_per_mql', 'up')).toBe('down');
  });

  it('falls back to configuration only for a formula it does not know', () => {
    expect(improvementDirectionFor('a_tenants_own_metric', 'up')).toBe('up');
    expect(improvementDirectionFor('a_tenants_own_metric', 'down')).toBe('down');
    expect(improvementDirectionFor('a_tenants_own_metric')).toBeNull();
    // And never for one it does.
    expect(improvementDirectionFor('cost_per_funded_deal', 'up')).toBe('down');
  });

  it('does not mistake an unrelated word for a cost', () => {
    for (const formula of ['stage_count', 'funded_volume', 'qualified_rate']) {
      expect(looksLikeCost(formula)).toBe(false);
    }
  });

  it('declares nothing twice and nothing empty', () => {
    const formulas = declaredFormulas();
    expect(new Set(formulas).size).toBe(formulas.length);
    expect(formulas.every((f) => f.length > 0)).toBe(true);
  });
});

describe('the colour that results', () => {
  /**
   * The end-to-end statement, because the two halves are tested apart and it is
   * their combination that appears on screen: a cost that rose must read as a
   * regression, and one that fell as an improvement.
   */
  it('paints a rising cost per funded deal as a regression', () => {
    const direction = improvementDirectionFor('cost_per_funded_deal')!;
    expect(delta(9000, 8000, direction).assessment).toBe('shortfall');
    expect(delta(7000, 8000, direction).assessment).toBe('ahead');
    expect(delta(8000, 8000, direction).assessment).toBe('level');
  });

  it('paints a rising conversion rate as an improvement', () => {
    const direction = improvementDirectionFor('stage_conversion_rate')!;
    expect(delta(0.2, 0.1, direction).assessment).toBe('ahead');
    expect(delta(0.05, 0.1, direction).assessment).toBe('shortfall');
  });

  it('assesses spend neither way, whichever way it moved', () => {
    expect(improvementDirectionFor('paid_media_spend')).toBeNull();
  });
});
