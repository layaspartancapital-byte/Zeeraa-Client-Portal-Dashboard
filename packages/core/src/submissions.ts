/**
 * Metrics over lender submissions.
 *
 * Not a replacement for `decline-reasons.ts`, which handles a single-value
 * field on the opportunity and renders shares over the whole population. A
 * submission's reasons are a multipicklist at lender grain, so they count
 * citations rather than shares — the two cannot use one function without one
 * of them lying about its denominator.
 *
 * The deal-level offer rate this replaces was 58.8% because it divided two
 * counts of the same event: a deal moves to Approved when a lender offer
 * arrives, so "approved that went on to receive an offer" was measuring
 * whether somebody typed a date. Here a submission is one lender's answer on
 * one deal, and the rate divides answers by answers.
 */

/** The three outcomes, as ingested. */
export type SubmissionTally = {
  offered: number;
  declined: number;
  undecided: number;
};

export type SubmissionOfferRate = {
  /**
   * Offers over decided submissions, or null when nothing has been decided.
   *
   * Null rather than zero: a window in which no lender has answered yet is not
   * a window in which every lender said no.
   */
  rate: number | null;
  offered: number;
  declined: number;
  /** The denominator, stated because it is not the submission count. */
  decided: number;
  /**
   * Submissions with no lender answer, which are excluded.
   *
   * Carried on the metric rather than left to a caption. Most submissions are
   * undecided at any moment — 706 of Spartan's 1,427 — so a reader who assumes
   * the denominator is every submission is out by a factor of two, and the
   * figure has no meaning without this beside it.
   */
  undecided: number;
  /** Decided share of all submissions, or null when there are none. */
  coverage: number | null;
};

/**
 * One lender's offer rate, or every lender's.
 *
 * Both halves come from the same set of submissions, which is the same rule
 * channel metrics follow: a lender's rate is its own offers over its own
 * decisions. Summing offers across lenders and dividing by one lender's
 * decisions would make a lender look better when a different one had a good
 * month.
 */
export function submissionOfferRate(tally: SubmissionTally): SubmissionOfferRate {
  const offered = Math.max(0, Math.trunc(tally.offered));
  const declined = Math.max(0, Math.trunc(tally.declined));
  const undecided = Math.max(0, Math.trunc(tally.undecided));
  const decided = offered + declined;
  const total = decided + undecided;

  return {
    rate: decided === 0 ? null : offered / decided,
    offered,
    declined,
    decided,
    undecided,
    coverage: total === 0 ? null : decided / total,
  };
}

/** The undecided reason the connector writes for an open lender status. */
export const AWAITING_LENDER_ANSWER = 'awaiting a lender answer';

/**
 * Where an undecided submission actually stands.
 *
 * "Submitted" is what the lender left on it, not a fact about now: a lender
 * that never answers leaves the status alone after the deal is funded
 * elsewhere, declined or lost. In Spartan's org 570 of 624 submissions "waiting
 * on a lender reply" sat on deals Salesforce had already closed (24 September
 * 2026). So an open status on a closed deal is `closed_unanswered` — nobody is
 * waiting — and only an open status on an open deal is `waiting`.
 *
 *   - `waiting`            open status, deal not closed (or not yet known to be)
 *   - `closed_unanswered`  open status, deal closed without this lender replying
 *   - `not_completed`      the submission failed, or its status says nothing
 */
export type PendingState = 'waiting' | 'closed_unanswered' | 'not_completed';

export function pendingState(undecidedReason: string | null, dealClosed: boolean | null): PendingState {
  if (undecidedReason !== AWAITING_LENDER_ANSWER) return 'not_completed';
  return dealClosed === true ? 'closed_unanswered' : 'waiting';
}

export type PendingTally = Record<PendingState, number>;

export const EMPTY_PENDING: PendingTally = { waiting: 0, closed_unanswered: 0, not_completed: 0 };

/**
 * Coverage of the decline-reason field in one period.
 *
 * Per period on purpose. `Decline_Reason__c` is being adopted rather than
 * used — 0% in June, 15.4% in July, 9.1% in August, 30.5% in September — so a
 * single all-time figure averages an unused field with an adopted one and
 * describes neither month. There is deliberately no function here that returns
 * one.
 */
export type ReasonCoverage = {
  period: string;
  declined: number;
  withReason: number;
  /** Null when nothing was declined in the period: no denominator, no share. */
  share: number | null;
};

export function reasonCoverageByPeriod(
  buckets: Record<string, { declined: number; withReason: number }>,
): ReasonCoverage[] {
  return Object.entries(buckets)
    .map(([period, { declined, withReason }]) => ({
      period,
      declined,
      withReason,
      share: declined === 0 ? null : withReason / declined,
    }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

/**
 * Citations of each decline reason, ranked.
 *
 * A count of citations, never a share of declines: the source is a
 * multipicklist, so one lender can cite three reasons for one decline and the
 * citations sum above the declines. `total` is the citation count so a caller
 * cannot accidentally divide by the wrong thing, and `declinesWithReason` is
 * the population the citations came from.
 */
export type ReasonCitations = {
  reasons: { reason: string; citations: number }[];
  total: number;
  declinesWithReason: number;
};

export function rankReasonCitations(
  rows: readonly { reasons: readonly string[] | null }[],
): ReasonCitations {
  const counts = new Map<string, number>();
  let declinesWithReason = 0;
  let total = 0;

  for (const row of rows) {
    const reasons = row.reasons?.filter((r) => r.trim() !== '') ?? [];
    if (reasons.length === 0) continue;
    declinesWithReason += 1;
    // De-duplicated within a submission: a multipicklist should not hold the
    // same value twice, and if it does that is one lender's opinion, not two.
    for (const reason of new Set(reasons.map((r) => r.trim()))) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
      total += 1;
    }
  }

  return {
    reasons: [...counts]
      .map(([reason, citations]) => ({ reason, citations }))
      .sort((a, b) => b.citations - a.citations || a.reason.localeCompare(b.reason)),
    total,
    declinesWithReason,
  };
}
