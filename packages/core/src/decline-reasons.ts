/**
 * Decline reasons, with the gap shown.
 *
 * Spartan's org populates a decline reason on 16.4% of closed-lost
 * opportunities. The tempting thing to do with that is compute shares over the
 * records that have a value, which yields a clean chart summing to 100% and
 * says something completely untrue: it reports the composition of a 16% sample
 * as though it were the composition of the whole.
 *
 * So every share here is over the total, "not recorded" is a first-class
 * category rather than an omission, and the two always sum to one. A reader who
 * glances at the chart should see immediately that most of it is unknown.
 */

export type DeclineRow = { reason: string | null | undefined };

export type DeclineShare = {
  reason: string;
  count: number;
  /** Over the total, including records with no reason. Never renormalised. */
  share: number;
};

export type DeclineBreakdown = {
  total: number;
  recorded: number;
  notRecorded: number;
  /** Share of the total with no reason recorded. */
  notRecordedShare: number;
  /** Descending by count. Excludes the not-recorded group. */
  reasons: DeclineShare[];
  /**
   * True when the recorded share is too small for the composition to be worth
   * reading as representative. The UI states this rather than hiding it.
   */
  sparse: boolean;
};

/**
 * Below this, the recorded reasons describe a minority so small that their
 * relative proportions are not evidence of anything about the whole.
 */
export const SPARSE_THRESHOLD = 0.6;

export function declineReasonBreakdown(
  rows: readonly DeclineRow[],
  sparseThreshold = SPARSE_THRESHOLD,
): DeclineBreakdown {
  const total = rows.length;
  const counts = new Map<string, number>();
  let recorded = 0;

  for (const row of rows) {
    const reason = row.reason?.trim();
    if (!reason) continue;
    recorded += 1;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  const notRecorded = total - recorded;

  return {
    total,
    recorded,
    notRecorded,
    notRecordedShare: total === 0 ? 0 : notRecorded / total,
    reasons: [...counts.entries()]
      .map(([reason, count]) => ({ reason, count, share: total === 0 ? 0 : count / total }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    sparse: total === 0 ? true : recorded / total < sparseThreshold,
  };
}

/**
 * The sentence the funnel view puts beside the breakdown. Plain, not
 * apologetic, and specific about what is missing.
 */
export function describeCoverage(breakdown: DeclineBreakdown): string {
  if (breakdown.total === 0) return 'No closed-lost opportunities in this period.';
  const pct = ((breakdown.recorded / breakdown.total) * 100).toFixed(1);
  return (
    `A reason is recorded on ${pct}% of the ${breakdown.total} declined ` +
    `${breakdown.total === 1 ? 'deal' : 'deals'} in this period. ` +
    `The remaining ${breakdown.notRecorded} are shown as not recorded rather ` +
    'than left out.'
  );
}
