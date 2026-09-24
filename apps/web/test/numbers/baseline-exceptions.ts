/**
 * Frozen baseline figures the current code is allowed to differ from, each
 * with the reason (the pre-deploy number check, `baseline.numbers.ts`).
 *
 * A difference not listed here fails the deploy. An entry whose difference
 * has gone also fails, so the list cannot rot into a blanket allowance: when
 * a correction is frozen as the next version, remove the entry.
 *
 * `platform|metric` uses the frozen row's own names.
 */
export type BaselineException = {
  tenant: string;
  /** `YYYY-MM`. */
  month: string;
  platform: string;
  metric: string;
  /** What the frozen row holds, and what the code computes now. */
  frozen: number | null;
  computed: number | null;
  reason: string;
};

const RULE_REVERSED =
  'Frozen under the minimum-deal rule (withheld below 3 deals). The rule was reversed for costs on ' +
  '24 September 2026: a cost always shows its number. Remove when a version 2 is frozen with that reason.';

export const BASELINE_EXCEPTIONS: BaselineException[] = [
  { tenant: 'spartan', month: '2026-06', platform: 'google_ads', metric: 'cpa', frozen: null, computed: 12812.5345, reason: RULE_REVERSED },
  { tenant: 'spartan', month: '2026-06', platform: 'google_ads', metric: 'costPerFundedDeal', frozen: null, computed: 6406.26725, reason: RULE_REVERSED },
];
