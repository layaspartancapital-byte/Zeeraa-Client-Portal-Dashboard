/**
 * Call metrics.
 *
 * Three rules govern everything here, and all three exist because a call log
 * is the easiest data in this product to overstate:
 *
 *   * **Connected, attempted and abandoned are counted separately.** An
 *     abandoned call is one the caller ended before anybody answered. It is
 *     neither a conversation nor an agent's attempt to have one, and folding
 *     it into either inflates that one. 2,002 of Spartan's 28,863 calls are
 *     abandoned.
 *   * **Speed to lead is measured only on leads that were called.** A lead
 *     with no outbound call has no speed to lead — it is not slow, it is
 *     absent from the measurement — so the population is stated with the
 *     figure and never inferred from the total lead count.
 *   * **The median, not the mean.** One lead called three weeks late moves a
 *     mean by minutes and tells you nothing about the desk's habits. Both are
 *     returned so nobody has to recompute, and p90 is there because the tail
 *     is the part a client argues about.
 */

export type CallOutcome = 'connected' | 'attempted' | 'abandoned';

export type CallTally = {
  connected: number;
  attempted: number;
  abandoned: number;
};

export type CallVolume = CallTally & {
  /** Every call, including abandoned. */
  total: number;
  /**
   * Calls an agent placed or answered — connected plus attempted.
   *
   * Named rather than left to the caller to add up, because "calls" with an
   * abandoned bucket in the data is ambiguous and the ambiguity is exactly
   * what produces a wrong number on a slide.
   */
  handled: number;
  /**
   * Connected over handled, or null when nothing was handled.
   *
   * Abandoned calls are *not* in this denominator: the desk cannot connect a
   * call the caller hung up, and counting those against it measures the
   * client's own marketing rather than the desk.
   */
  connectRate: number | null;
};

export function callVolume(tally: CallTally): CallVolume {
  const connected = Math.max(0, Math.trunc(tally.connected));
  const attempted = Math.max(0, Math.trunc(tally.attempted));
  const abandoned = Math.max(0, Math.trunc(tally.abandoned));
  const handled = connected + attempted;

  return {
    connected,
    attempted,
    abandoned,
    handled,
    total: handled + abandoned,
    connectRate: handled === 0 ? null : connected / handled,
  };
}

/* ------------------------------------------------------------------------- */
/* Speed to lead                                                             */
/* ------------------------------------------------------------------------- */

export type SpeedToLeadInput = {
  /** Seconds from the lead being created to the first outbound call. */
  seconds: number;
};

export type SpeedToLead = {
  /** Leads with at least one outbound call, which is the population. */
  called: number;
  /**
   * Leads in the window with no outbound call at all.
   *
   * Beside the figure, not below it. A median of four minutes over 12% of the
   * leads is a different claim from a median of four minutes, and the second
   * is what a reader takes from a bare number.
   */
  notCalled: number;
  /** Called over called plus not called, or null when there are no leads. */
  coverage: number | null;
  /** Null when nobody was called: there is no middle of an empty set. */
  medianSeconds: number | null;
  meanSeconds: number | null;
  p90Seconds: number | null;
  /** Called within five minutes, the industry's own bar. */
  withinFiveMinutes: number;
  /** Share of *called* leads reached within five minutes. Never of all leads. */
  withinFiveMinutesShare: number | null;
};

const FIVE_MINUTES = 5 * 60;

export function speedToLead(
  rows: readonly SpeedToLeadInput[],
  notCalled: number,
): SpeedToLead {
  /*
   * A negative interval is dropped rather than clamped to zero.
   *
   * It means the call is stamped before the lead, which happens when a
   * merchant rings in and the lead is created during the conversation. That is
   * a real event and a genuine zero-second response, but it is not a *response
   * to* the lead — averaging it in as zero would flatter the desk with calls it
   * made before it had anything to call.
   */
  const seconds = rows
    .map((r) => r.seconds)
    .filter((s) => Number.isFinite(s) && s >= 0)
    .sort((a, b) => a - b);

  const called = seconds.length;
  const population = called + Math.max(0, Math.trunc(notCalled));

  if (called === 0) {
    return {
      called: 0,
      notCalled: Math.max(0, Math.trunc(notCalled)),
      coverage: population === 0 ? null : 0,
      medianSeconds: null,
      meanSeconds: null,
      p90Seconds: null,
      withinFiveMinutes: 0,
      withinFiveMinutesShare: null,
    };
  }

  const within = seconds.filter((s) => s <= FIVE_MINUTES).length;

  return {
    called,
    notCalled: Math.max(0, Math.trunc(notCalled)),
    coverage: population === 0 ? null : called / population,
    medianSeconds: quantile(seconds, 0.5),
    meanSeconds: seconds.reduce((sum, s) => sum + s, 0) / called,
    p90Seconds: quantile(seconds, 0.9),
    withinFiveMinutes: within,
    withinFiveMinutesShare: within / called,
  };
}

/**
 * Nearest-rank quantile on a sorted array.
 *
 * No interpolation: these are observed response times, and a median of 214.5
 * seconds when no call took that long is a number nobody can go and look at.
 */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}

/* ------------------------------------------------------------------------- */
/* Attempts per lead                                                         */
/* ------------------------------------------------------------------------- */

export type AttemptsPerLead = {
  /** Leads with at least one call. The denominator. */
  leadsCalled: number;
  /** Outbound calls placed to those leads, abandoned excluded. */
  attempts: number;
  /** Attempts over leads called, or null when none were. */
  mean: number | null;
  median: number | null;
  /** Leads reached on the first call, as a share of leads called. */
  connectedFirstAttempt: number;
  /**
   * Leads called more than once without ever connecting.
   *
   * The number a desk manager actually wants: effort spent on numbers that
   * never answer.
   */
  chasedNeverConnected: number;
};

export type LeadCallSummary = {
  attempts: number;
  connected: boolean;
  /** Whether the first attempt was the one that connected. */
  connectedOnFirst: boolean;
};

export function attemptsPerLead(rows: readonly LeadCallSummary[]): AttemptsPerLead {
  const called = rows.filter((r) => r.attempts > 0);
  if (called.length === 0) {
    return {
      leadsCalled: 0,
      attempts: 0,
      mean: null,
      median: null,
      connectedFirstAttempt: 0,
      chasedNeverConnected: 0,
    };
  }

  const counts = called.map((r) => r.attempts).sort((a, b) => a - b);
  const attempts = counts.reduce((sum, n) => sum + n, 0);

  return {
    leadsCalled: called.length,
    attempts,
    mean: attempts / called.length,
    median: quantile(counts, 0.5),
    connectedFirstAttempt: called.filter((r) => r.connectedOnFirst).length,
    chasedNeverConnected: called.filter((r) => !r.connected && r.attempts > 1).length,
  };
}

/**
 * A duration a person can read, from seconds.
 *
 * Speed to lead spans four orders of magnitude in the same column — eleven
 * seconds and nine days — so a single unit makes half the table unreadable.
 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
