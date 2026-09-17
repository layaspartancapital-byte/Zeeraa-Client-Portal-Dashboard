/**
 * Lead qualification.
 *
 * Drives `qualified_rate`, and — for this tenant — also stands in for the MQL
 * stage, which has no timestamp field in Salesforce. A lead that meets the
 * configured minimums is treated as having reached MQL at the moment it was
 * created.
 *
 * That derivation is only valid while MQL means "meets the minimums". If it
 * ever comes to mean "a rep qualified it", this silently produces a different
 * number, so anything built on it is marked as computed rather than observed.
 */

export type QualificationMinimums = {
  monthlyRevenueMin?: number;
  timeInBusinessMonthsMin?: number;
};

export type QualifiableLead = {
  selfReportedRevenue?: number | null;
  selfReportedTimeInBusinessMonths?: number | null;
};

export type QualificationResult =
  | { qualified: true }
  | { qualified: false; reasons: string[] }
  /**
   * Distinct from `false`: the lead did not fail the test, the data to run it
   * is absent. Counting these as unqualified would understate the rate by
   * however many forms happen to skip the question.
   */
  | { qualified: null; missing: string[] };

export function qualifyLead(
  lead: QualifiableLead,
  minimums: QualificationMinimums,
): QualificationResult {
  const missing: string[] = [];
  const reasons: string[] = [];

  if (minimums.monthlyRevenueMin != null) {
    if (lead.selfReportedRevenue == null) missing.push('monthly revenue');
    else if (lead.selfReportedRevenue < minimums.monthlyRevenueMin) {
      reasons.push(
        `monthly revenue below $${minimums.monthlyRevenueMin.toLocaleString('en-US')}`,
      );
    }
  }

  if (minimums.timeInBusinessMonthsMin != null) {
    if (lead.selfReportedTimeInBusinessMonths == null) missing.push('time in business');
    else if (lead.selfReportedTimeInBusinessMonths < minimums.timeInBusinessMonthsMin) {
      reasons.push(`time in business below ${minimums.timeInBusinessMonthsMin} months`);
    }
  }

  if (reasons.length > 0) return { qualified: false, reasons };
  if (missing.length > 0) return { qualified: null, missing };
  return { qualified: true };
}

export type QualifiedRate = {
  total: number;
  qualified: number;
  unqualified: number;
  /** Neither qualified nor not — the inputs were absent. Reported separately. */
  undetermined: number;
  /** Over the total. The undetermined share is visible, never folded in. */
  rate: number;
  undeterminedShare: number;
};

export function qualifiedRate(
  leads: readonly QualifiableLead[],
  minimums: QualificationMinimums,
): QualifiedRate {
  let qualified = 0;
  let unqualified = 0;
  let undetermined = 0;

  for (const lead of leads) {
    const result = qualifyLead(lead, minimums);
    if (result.qualified === true) qualified += 1;
    else if (result.qualified === false) unqualified += 1;
    else undetermined += 1;
  }

  const total = leads.length;
  return {
    total,
    qualified,
    unqualified,
    undetermined,
    rate: total === 0 ? 0 : qualified / total,
    undeterminedShare: total === 0 ? 0 : undetermined / total,
  };
}
