import type { ImprovementDirection } from './format';
import { PACING_CONFIDENCE_ELAPSED, PACING_TOLERANCE } from './pacing';
import type { PopulationVerdict } from './population';
import { gapToTarget } from './ramp';

/**
 * One scorecard figure against its target: on target, or behind by how much.
 *
 * The executive scorecard answers the client's question in their words, so the
 * verdict is binary where the metric has a direction — ahead of target reads
 * "on target", because this is a record and not a report card — and states
 * over or under where it has none. Spend is the case: overspending is not a
 * failure and underspending is not an achievement (see `pacing.ts`).
 *
 * **A month in progress is judged against pace, not against the month.** A
 * count or a spend three weeks into a month is three weeks of it, so it is
 * compared with the target times the share of the month gone — the same
 * straight line `budgetPacing` uses. A rate or a cost needs no pro-rating (a
 * cost per deal is already per deal), but it does need the comparison floor:
 * a month-to-date cost over two deals moves by half when the third lands, and
 * "behind by $4,000" over two deals is the sample talking. Early in a month a
 * count is withheld the same way, below a quarter of the month.
 */
export type ScorecardVerdict =
  /** No target applies to this month: before M1, past the ramp, or unentered. */
  | { state: 'no_target'; reason: string }
  /** The month has no figure. Never a zero. */
  | { state: 'not_measured'; reason: string }
  /** A figure exists and is too thin to judge yet. */
  | { state: 'too_early'; reason: string }
  | { state: 'on_target'; paced: boolean }
  /** Short of target, in the metric's unit; always positive. */
  | { state: 'behind'; by: number; paced: boolean }
  /** A metric with no direction: stated, never judged. */
  | { state: 'over' | 'under'; by: number; paced: boolean };

export function scorecardVerdict(input: {
  actual: number | null;
  /** Why `actual` is null, where it is. */
  actualReason: string | null;
  target: number | null;
  /** Why `target` is null, where it is. */
  noTarget: string | null;
  /** From the metric's declaration. Null states over or under. */
  direction: ImprovementDirection | null;
  /** A rate or cost compares as-is; a count or a spend accumulates. */
  kind: 'rate' | 'count';
  /** The month in progress. */
  partial: boolean;
  /** 0–1, the share of the month gone. Read only for a partial month. */
  elapsed: number;
  /** A rate's comparison gate (`metrics.comparable`). */
  comparable?: PopulationVerdict;
}): ScorecardVerdict {
  const { actual, target, direction, kind, partial } = input;
  if (target === null) {
    return { state: 'no_target', reason: input.noTarget ?? 'No target is recorded for this month.' };
  }
  if (actual === null) {
    return { state: 'not_measured', reason: input.actualReason ?? 'No figure for this month.' };
  }
  if (kind === 'rate' && input.comparable && !input.comparable.sufficient) {
    return { state: 'too_early', reason: input.comparable.reason ?? 'Too few to compare yet.' };
  }

  const elapsed = Math.min(1, Math.max(0, input.elapsed));
  const paced = kind === 'count' && partial;
  if (paced && elapsed < PACING_CONFIDENCE_ELAPSED) {
    return { state: 'too_early', reason: 'Too early in the month to compare with the monthly target.' };
  }

  const reference = paced ? target * elapsed : target;
  const distance = actual - reference;
  // A band, not a point: nothing lands exactly on a target, and a card that
  // says "behind by $3" is crying wolf. The pacing card's five per cent.
  if (reference !== 0 && Math.abs(distance) <= Math.abs(reference) * PACING_TOLERANCE) {
    return { state: 'on_target', paced };
  }
  if (direction === null) {
    return { state: distance > 0 ? 'over' : 'under', by: Math.abs(distance), paced };
  }
  const gap = gapToTarget(actual, reference, direction);
  return gap.assessment === 'shortfall'
    ? { state: 'behind', by: Math.abs(gap.absolute), paced }
    : { state: 'on_target', paced };
}
