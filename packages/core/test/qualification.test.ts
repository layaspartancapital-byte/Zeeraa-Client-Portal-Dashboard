import { describe, expect, it } from 'vitest';
import { qualifiedRate, qualifyLead } from '../src/qualification';

const SPARTAN = { monthlyRevenueMin: 10_000, timeInBusinessMonthsMin: 12 };

describe('lead qualification', () => {
  it('qualifies a lead meeting both minimums', () => {
    expect(
      qualifyLead({ selfReportedRevenue: 25_000, selfReportedTimeInBusinessMonths: 36 }, SPARTAN),
    ).toEqual({ qualified: true });
  });

  it('accepts a lead exactly on the boundary', () => {
    expect(
      qualifyLead({ selfReportedRevenue: 10_000, selfReportedTimeInBusinessMonths: 12 }, SPARTAN)
        .qualified,
    ).toBe(true);
  });

  it('says which minimum was missed', () => {
    const result = qualifyLead(
      { selfReportedRevenue: 4_000, selfReportedTimeInBusinessMonths: 36 },
      SPARTAN,
    );
    expect(result.qualified).toBe(false);
    expect(result).toMatchObject({ reasons: ['monthly revenue below $10,000'] });
  });

  it('distinguishes missing data from failing the test', () => {
    // Counting a lead that never answered as unqualified would understate the
    // rate by however many forms skip the question.
    const result = qualifyLead(
      { selfReportedRevenue: null, selfReportedTimeInBusinessMonths: 36 },
      SPARTAN,
    );
    expect(result.qualified).toBeNull();
    expect(result).toMatchObject({ missing: ['monthly revenue'] });
  });

  it('prefers a definite failure over missing data', () => {
    // Revenue is absent but time in business already disqualifies it.
    expect(
      qualifyLead({ selfReportedRevenue: null, selfReportedTimeInBusinessMonths: 3 }, SPARTAN)
        .qualified,
    ).toBe(false);
  });
});

describe('qualified rate', () => {
  it('reports the undetermined share separately rather than folding it in', () => {
    const rate = qualifiedRate(
      [
        { selfReportedRevenue: 20_000, selfReportedTimeInBusinessMonths: 24 },
        { selfReportedRevenue: 20_000, selfReportedTimeInBusinessMonths: 24 },
        { selfReportedRevenue: 1_000, selfReportedTimeInBusinessMonths: 24 },
        { selfReportedRevenue: null, selfReportedTimeInBusinessMonths: null },
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

  it('survives an empty period', () => {
    expect(qualifiedRate([], SPARTAN)).toMatchObject({ total: 0, rate: 0 });
  });
});
