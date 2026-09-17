/**
 * Lead qualification — Spartan's MQL bar.
 *
 * Both conditions together:
 *   - time in business >= 12 months, and
 *   - revenue >= $10,000 monthly gross (equivalently $120,000 annual gross)
 *
 * The two revenue figures are one threshold expressed at two periods, not two
 * tests. Records may carry either or both, so everything is normalised to a
 * monthly basis before comparison.
 *
 * This also stands in for the MQL stage, which has no timestamp field in
 * Salesforce. Both attributes are known at lead creation, so a qualifying lead
 * reached MQL when it was created. Anything built on that is marked `computed`
 * rather than `observed`, because a stage the platform inferred and a stage the
 * CRM recorded are different kinds of fact.
 *
 * Every number here arrives as configuration. Another client's bar is
 * different, and Spartan's will move.
 */

export type QualificationBar = {
  minMonthsInBusiness: number;
  minMonthlyRevenue: number;
  /**
   * How far a record's monthly and annual revenue figures may disagree before
   * the record is flagged. Expressed as a fraction of the monthly figure.
   * A disagreement past this point is usually a data-entry error — a monthly
   * figure typed into the annual field, most often — rather than a real one.
   */
  revenueDisagreementTolerance: number;
};

export const DEFAULT_REVENUE_TOLERANCE = 0.1;

export type ReportedRevenue = {
  monthly?: number | null;
  annual?: number | null;
};

export type NormalizedRevenue = {
  /** Null when neither figure is present. Not zero — absence is not zero. */
  monthly: number | null;
  /** Which figure it came from. `monthly` wins when both are present. */
  basis: 'monthly' | 'annual' | 'none';
  /** True when both were present and disagreed beyond the tolerance. */
  disagreement: boolean;
  /**
   * The monthly-equivalent implied by the annual figure, when both were
   * present. Kept so the flagged record can be shown rather than just counted.
   */
  monthlyFromAnnual?: number;
};

/**
 * Brings revenue onto a monthly basis.
 *
 * Preferring the monthly figure is deliberate: where both are filled in, the
 * monthly one is what the applicant was asked for directly, and the annual one
 * is more often a derived or mistyped value.
 */
export function normalizeMonthlyRevenue(
  reported: ReportedRevenue,
  tolerance = DEFAULT_REVENUE_TOLERANCE,
): NormalizedRevenue {
  const monthly = reported.monthly ?? null;
  const annual = reported.annual ?? null;

  if (monthly == null && annual == null) {
    return { monthly: null, basis: 'none', disagreement: false };
  }

  if (monthly == null) {
    return { monthly: annual! / 12, basis: 'annual', disagreement: false };
  }

  if (annual == null) {
    return { monthly, basis: 'monthly', disagreement: false };
  }

  const monthlyFromAnnual = annual / 12;
  const spread = monthly === 0 ? (monthlyFromAnnual === 0 ? 0 : Infinity) : Math.abs(monthlyFromAnnual - monthly) / Math.abs(monthly);

  return {
    monthly,
    basis: 'monthly',
    disagreement: spread > tolerance,
    monthlyFromAnnual,
  };
}

export type QualifiableLead = {
  revenue: ReportedRevenue;
  timeInBusinessMonths?: number | null;
};

export type QualificationResult = {
  /**
   * `null` means the test could not be run, which is distinct from failing it.
   * Counting an unanswered form as unqualified would understate the MQL rate by
   * however many forms skip the question.
   */
  qualified: boolean | null;
  /** Populated when `qualified` is false. */
  failed: string[];
  /** Populated when `qualified` is null. */
  missing: string[];
  revenue: NormalizedRevenue;
  /** Carries through to the record so a data-entry error can be corrected. */
  revenueDisagreement: boolean;
};

export function qualifyLead(lead: QualifiableLead, bar: QualificationBar): QualificationResult {
  const revenue = normalizeMonthlyRevenue(lead.revenue, bar.revenueDisagreementTolerance);
  const failed: string[] = [];
  const missing: string[] = [];

  if (lead.timeInBusinessMonths == null) missing.push('time in business');
  else if (lead.timeInBusinessMonths < bar.minMonthsInBusiness) {
    failed.push(`time in business below ${bar.minMonthsInBusiness} months`);
  }

  if (revenue.monthly == null) missing.push('revenue');
  else if (revenue.monthly < bar.minMonthlyRevenue) {
    failed.push(`monthly revenue below $${bar.minMonthlyRevenue.toLocaleString('en-US')}`);
  }

  // A definite failure outranks missing data: a lead that fails one condition
  // is unqualified whatever the other condition would have said.
  const qualified = failed.length > 0 ? false : missing.length > 0 ? null : true;

  return { qualified, failed, missing, revenue, revenueDisagreement: revenue.disagreement };
}

export type QualifiedRate = {
  total: number;
  qualified: number;
  unqualified: number;
  /** Neither — the inputs were absent. Reported separately, never folded in. */
  undetermined: number;
  rate: number;
  undeterminedShare: number;
  /** Records whose two revenue figures disagree beyond tolerance. */
  revenueDisagreements: number;
};

export function qualifiedRate(
  leads: readonly QualifiableLead[],
  bar: QualificationBar,
): QualifiedRate {
  let qualified = 0;
  let unqualified = 0;
  let undetermined = 0;
  let revenueDisagreements = 0;

  for (const lead of leads) {
    const result = qualifyLead(lead, bar);
    if (result.revenueDisagreement) revenueDisagreements += 1;
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
    revenueDisagreements,
  };
}
