import { describe, expect, it } from 'vitest';
import {
  normalizeMonthlyRevenue,
  qualifiedRate,
  qualifyLead,
  type QualificationBar,
} from '../src/qualification';

/** Spartan's bar, as settled. Configuration, not constants. */
const SPARTAN: QualificationBar = {
  minMonthsInBusiness: 12,
  minMonthlyRevenue: 10_000,
  revenueDisagreementTolerance: 0.1,
};

describe('revenue normalisation', () => {
  it('treats $120,000 annual as $10,000 monthly — one threshold, two periods', () => {
    expect(normalizeMonthlyRevenue({ annual: 120_000 })).toMatchObject({
      monthly: 10_000,
      basis: 'annual',
    });
  });

  it('prefers the monthly figure when both are present', () => {
    // The monthly figure is what the applicant was asked for directly.
    expect(normalizeMonthlyRevenue({ monthly: 15_000, annual: 180_000 })).toMatchObject({
      monthly: 15_000,
      basis: 'monthly',
      disagreement: false,
    });
  });

  it('tolerates rounding between the two figures', () => {
    // 15,000/month against 179,000/year is a 0.6% spread — not an error.
    expect(normalizeMonthlyRevenue({ monthly: 15_000, annual: 179_000 }).disagreement).toBe(false);
  });

  it('flags the classic data-entry error: a monthly figure in the annual field', () => {
    const result = normalizeMonthlyRevenue({ monthly: 15_000, annual: 15_000 });
    expect(result.disagreement).toBe(true);
    expect(result.monthly).toBe(15_000);
    expect(result.monthlyFromAnnual).toBe(1_250);
  });

  it('flags an annual figure typed into the monthly field', () => {
    expect(normalizeMonthlyRevenue({ monthly: 180_000, annual: 180_000 }).disagreement).toBe(true);
  });

  it('reports absence as null rather than zero', () => {
    expect(normalizeMonthlyRevenue({})).toMatchObject({ monthly: null, basis: 'none' });
  });

  it('respects a different tolerance', () => {
    expect(normalizeMonthlyRevenue({ monthly: 10_000, annual: 132_000 }, 0.5).disagreement).toBe(false);
    expect(normalizeMonthlyRevenue({ monthly: 10_000, annual: 132_000 }, 0.05).disagreement).toBe(true);
  });
});

describe('the MQL bar', () => {
  it('requires both conditions, not either', () => {
    expect(
      qualifyLead({ revenue: { monthly: 50_000 }, timeInBusinessMonths: 3 }, SPARTAN).qualified,
    ).toBe(false);
    expect(
      qualifyLead({ revenue: { monthly: 2_000 }, timeInBusinessMonths: 60 }, SPARTAN).qualified,
    ).toBe(false);
    expect(
      qualifyLead({ revenue: { monthly: 50_000 }, timeInBusinessMonths: 60 }, SPARTAN).qualified,
    ).toBe(true);
  });

  it('qualifies a lead exactly on both boundaries', () => {
    expect(
      qualifyLead({ revenue: { monthly: 10_000 }, timeInBusinessMonths: 12 }, SPARTAN).qualified,
    ).toBe(true);
  });

  it('qualifies on an annual figure alone', () => {
    expect(
      qualifyLead({ revenue: { annual: 120_000 }, timeInBusinessMonths: 24 }, SPARTAN).qualified,
    ).toBe(true);
    expect(
      qualifyLead({ revenue: { annual: 119_000 }, timeInBusinessMonths: 24 }, SPARTAN).qualified,
    ).toBe(false);
  });

  it('says which condition was missed', () => {
    expect(
      qualifyLead({ revenue: { monthly: 4_000 }, timeInBusinessMonths: 4 }, SPARTAN).failed,
    ).toEqual(['time in business below 12 months', 'monthly revenue below $10,000']);
  });

  it('separates missing data from failing the bar', () => {
    const result = qualifyLead({ revenue: {}, timeInBusinessMonths: 24 }, SPARTAN);
    expect(result.qualified).toBeNull();
    expect(result.missing).toEqual(['revenue']);
  });

  it('reports a lead with neither attribute as undetermined', () => {
    const result = qualifyLead({ revenue: {}, timeInBusinessMonths: null }, SPARTAN);
    expect(result.qualified).toBeNull();
    expect(result.missing).toEqual(['time in business', 'revenue']);
  });

  it('lets a definite failure outrank missing data', () => {
    // Revenue is absent, but three months in business already disqualifies it.
    expect(qualifyLead({ revenue: {}, timeInBusinessMonths: 3 }, SPARTAN).qualified).toBe(false);
  });

  it('carries the revenue disagreement through to the record', () => {
    const result = qualifyLead(
      { revenue: { monthly: 15_000, annual: 15_000 }, timeInBusinessMonths: 24 },
      SPARTAN,
    );
    expect(result.qualified).toBe(true);
    expect(result.revenueDisagreement).toBe(true);
  });

  it('moves with the bar rather than with a constant', () => {
    const stricter = { ...SPARTAN, minMonthlyRevenue: 25_000, minMonthsInBusiness: 24 };
    const lead = { revenue: { monthly: 15_000 }, timeInBusinessMonths: 18 };
    expect(qualifyLead(lead, SPARTAN).qualified).toBe(true);
    expect(qualifyLead(lead, stricter).qualified).toBe(false);
  });
});

describe('qualified rate', () => {
  it('keeps the undetermined share visible', () => {
    const rate = qualifiedRate(
      [
        { revenue: { monthly: 20_000 }, timeInBusinessMonths: 24 },
        { revenue: { annual: 240_000 }, timeInBusinessMonths: 24 },
        { revenue: { monthly: 1_000 }, timeInBusinessMonths: 24 },
        { revenue: {}, timeInBusinessMonths: null },
      ],
      SPARTAN,
    );
    expect(rate).toMatchObject({
      total: 4,
      qualified: 2,
      unqualified: 1,
      undetermined: 1,
      rate: 0.5,
      undeterminedShare: 0.25,
    });
  });

  it('counts records whose revenue figures disagree', () => {
    expect(
      qualifiedRate(
        [
          { revenue: { monthly: 15_000, annual: 15_000 }, timeInBusinessMonths: 24 },
          { revenue: { monthly: 15_000, annual: 180_000 }, timeInBusinessMonths: 24 },
        ],
        SPARTAN,
      ).revenueDisagreements,
    ).toBe(1);
  });

  it('survives an empty period', () => {
    expect(qualifiedRate([], SPARTAN)).toMatchObject({ total: 0, rate: 0 });
  });
});
