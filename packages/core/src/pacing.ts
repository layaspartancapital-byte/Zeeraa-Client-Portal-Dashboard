import type { Delta, ImprovementDirection } from './format';

/**
 * Budget pacing: how a month's spend so far reads against what the month
 * contracts.
 *
 * The figure a client actually asks for is not "how much have we spent" — that
 * is on the card already — but "at this rate, where do we land". So the metric
 * is the projection and the variance against budget, and the naive version of
 * it is wrong in a way nobody notices:
 *
 *   **Spend is not linear across a month and the projection must not pretend
 *   otherwise on day one.** Two days into a month, one heavy day doubles the
 *   projection. The projection is still the right figure to report, but it is
 *   unstable early and stable late, so `confident` says which it is and the
 *   screen renders the projection differently below the bar. A number that is
 *   arithmetically correct and volatile is exactly the kind a client repeats in
 *   a meeting and then holds you to.
 *
 * Direction is deliberately absent. Overspending is not a failure and
 * underspending is not an achievement — what the spend bought decides that, and
 * `paid_media_spend` is declared neutral in `metric-direction` for the same
 * reason. What this reports is distance from plan, not a verdict on it.
 */

export type BudgetPacing = {
  spent: number;
  budget: number;
  /** Elapsed share of the month, 0–1. */
  elapsed: number;
  /** Spent over budget, which may exceed 1. */
  spentShare: number;
  /**
   * Where the month lands at this rate: spend so far divided by the elapsed
   * share. Null when no time has elapsed — there is no rate on day zero.
   */
  projected: number | null;
  /** Projected minus budget. Positive is over. Null where projection is. */
  variance: number | null;
  /**
   * Whether the projection has enough of the month behind it to be worth
   * stating as a number rather than as a direction.
   *
   * A quarter of the month. Below it the projection still renders — withholding
   * it would leave the reader to do worse arithmetic in their head — but the
   * screen says it is early, because on day three it swings by thousands.
   */
  confident: boolean;
  /**
   * How far ahead or behind the straight line the spend is, in share points.
   * Positive is spending faster than the month is passing.
   */
  drift: number;
};

/** Below this much of the month elapsed, a projection is volatile. */
export const PACING_CONFIDENCE_ELAPSED = 0.25;

export function budgetPacing(input: {
  spent: number;
  budget: number;
  elapsed: number;
}): BudgetPacing | null {
  const budget = Number(input.budget);
  // No budget is not a budget of zero. A pacing figure against nothing is a
  // division by nothing, and the screen has to say the budget is unrecorded
  // rather than draw a bar at infinity.
  if (!Number.isFinite(budget) || budget <= 0) return null;

  const spent = Math.max(0, Number(input.spent) || 0);
  const elapsed = Math.min(1, Math.max(0, Number(input.elapsed) || 0));
  const spentShare = spent / budget;
  const projected = elapsed === 0 ? null : spent / elapsed;

  return {
    spent,
    budget,
    elapsed,
    spentShare,
    projected,
    variance: projected === null ? null : projected - budget,
    confident: elapsed >= PACING_CONFIDENCE_ELAPSED,
    drift: spentShare - elapsed,
  };
}

/**
 * Pacing as a word, for the badge.
 *
 * `on_plan` is a band rather than a point: nothing lands exactly on its budget,
 * and a card that says "over" because a month is tracking 0.4% hot is a card
 * that cries wolf every month. Five per cent of the budget either way.
 */
export type PacingState = 'on_plan' | 'over' | 'under';

export const PACING_TOLERANCE = 0.05;

export function pacingState(pacing: BudgetPacing): PacingState {
  if (pacing.variance === null) return 'on_plan';
  const relative = pacing.variance / pacing.budget;
  if (relative > PACING_TOLERANCE) return 'over';
  if (relative < -PACING_TOLERANCE) return 'under';
  return 'on_plan';
}

/**
 * Pacing carries no improvement direction, stated as a value rather than left
 * to each card to remember.
 *
 * Exported so a screen that wants to colour a pacing delta has something to
 * pass, and gets neutral — which is the answer.
 */
export const PACING_DIRECTION: ImprovementDirection | null = null;

/** The assessment a pacing state maps to, for the shared tone helper. */
export function pacingAssessment(state: PacingState): Delta['assessment'] {
  // Every state is `level`: distance from plan is information, not a verdict.
  // Kept as a function so a future engagement that *does* treat overspend as a
  // regression has one place to say so.
  void state;
  return 'level';
}
