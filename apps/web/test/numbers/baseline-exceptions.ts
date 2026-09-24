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

export const BASELINE_EXCEPTIONS: BaselineException[] = [];
