import { delta, type Delta, type ImprovementDirection } from './format';
import { channelCostPerDeal, type ChannelCostPerDeal } from './attribution';
import { daySpans, formatRangeLabel, type RangeCoverage } from './date-range';
import { assessPopulation } from './population';

/**
 * The engagement ramp: what a metric is contracted to reach, month by month.
 *
 * Zeeraa signs an engagement against a curve rather than a single number — an
 * eight-month decline in cost per funded deal, with a budget and a set of
 * volume targets beside it. The figures themselves are configuration, per
 * tenant and per channel, because they are what this client signed; what lives
 * here is the arithmetic that turns "month 3 of the ramp" into "October 2026"
 * and back, which is the same for every engagement.
 *
 * **The start month is the whole reason this is not a lookup table.** M1 is
 * whenever the contract begins, which is decided when it is signed and is not
 * knowable from the data. Until somebody records it, a target exists as a shape
 * with no position on the calendar, and the product must say so rather than
 * assume the engagement began when ingestion did.
 */

export type RampTarget = {
  /** 1-based. M1 is the first month of the engagement. */
  monthIndex: number;
  costPerFundedDeal: number | null;
  budget: number | null;
  cpa: number | null;
  approvals: number | null;
  fundedDeals: number | null;
  /** Contracted funded volume for the month, the model's Funded Amount column. */
  fundedAmount: number | null;
};

/** `YYYY-MM`. Months, not days: the ramp is contracted monthly. */
export type MonthKey = string;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonthKey(value: string): value is MonthKey {
  return MONTH.test(value);
}

/** The `YYYY-MM` a tenant-local `YYYY-MM-DD` falls in. */
export function monthKeyOf(day: string): MonthKey {
  return day.slice(0, 7);
}

/**
 * Which month of the ramp a calendar month is, or null if it is before the
 * engagement started.
 *
 * Returns an index past the end of the ramp rather than null — month 9 of an
 * eight-month ramp is a real answer, and the caller decides that there is no
 * target for it. Conflating "before we started" with "past the end" would let
 * a chart draw the last target forever.
 */
export function rampMonthIndex(startMonth: MonthKey, month: MonthKey): number | null {
  if (!isMonthKey(startMonth) || !isMonthKey(month)) return null;
  const months =
    (Number(month.slice(0, 4)) - Number(startMonth.slice(0, 4))) * 12 +
    (Number(month.slice(5, 7)) - Number(startMonth.slice(5, 7)));
  return months < 0 ? null : months + 1;
}

/** The calendar month a ramp index lands on. The inverse of the above. */
export function rampMonthKey(startMonth: MonthKey, monthIndex: number): MonthKey | null {
  if (!isMonthKey(startMonth) || monthIndex < 1) return null;
  const zeroBased = Number(startMonth.slice(5, 7)) - 1 + (monthIndex - 1);
  const year = Number(startMonth.slice(0, 4)) + Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * The target for one calendar month, or null where there is none.
 *
 * Null covers three different situations and the caller renders them the same
 * way — as an absence — because they are all "no target applies here": the
 * engagement has no start month recorded, the month predates it, or it is past
 * the end of the ramp.
 */
export function targetForMonth(
  ramp: readonly RampTarget[],
  startMonth: MonthKey | null,
  month: MonthKey,
): RampTarget | null {
  if (!startMonth) return null;
  const index = rampMonthIndex(startMonth, month);
  if (index === null) return null;
  return ramp.find((t) => t.monthIndex === index) ?? null;
}

export type TargetGap = {
  /** Signed: positive is above target, which for a cost is behind. */
  absolute: number;
  /** Signed proportional distance, or null where the target is zero. */
  relative: number | null;
  assessment: Delta['assessment'];
  target: number;
  actual: number;
};

/**
 * How far a figure is from its target, as a number rather than as a position on
 * a chart.
 *
 * The assessment runs through `delta` with the metric's own improvement
 * direction, so a cost *below* target reads as ahead. Reusing it rather than
 * writing `actual < target` keeps one definition of what better means — the
 * same one that colours every delta in the product.
 */
export function gapToTarget(
  actual: number,
  target: number,
  direction: ImprovementDirection,
): TargetGap {
  const d = delta(actual, target, direction);
  return {
    absolute: d.absolute,
    relative: d.relative,
    assessment: d.assessment,
    target,
    actual,
  };
}

/**
 * Which way a series has moved overall, assessed by the metric's direction.
 *
 * First measured point against last measured, not point to point: a month of
 * noise in the middle is not a trend, and a line recoloured at every segment
 * reports texture as meaning. Gaps are skipped rather than bridged — the months
 * nobody ingested are not part of the movement.
 */
export function seriesTrend(
  values: readonly (number | null)[],
  direction: ImprovementDirection | null,
): Delta['assessment'] {
  if (direction === null) return 'level';
  const measured = values.filter((v): v is number => v !== null);
  if (measured.length < 2) return 'level';
  return delta(measured.at(-1)!, measured[0]!, direction).assessment;
}

/* ------------------------------------------------------------------------- */
/* The contracted curve as a series                                          */
/* ------------------------------------------------------------------------- */

/**
 * The metrics an engagement contracts, in the order a briefing reads them.
 *
 * Named rather than inferred from the object's keys so that adding a column to
 * `engagement_targets` does not silently add a panel to a screen, and so the
 * order is a decision somebody made rather than whatever `Object.keys` returns.
 */
export const RAMP_METRICS = [
  'costPerFundedDeal',
  'cpa',
  'budget',
  'approvals',
  'fundedDeals',
  'fundedAmount',
] as const;

export type RampMetricKey = (typeof RAMP_METRICS)[number];

/**
 * One month of a tracked curve: what was contracted, what happened, and the
 * distance between them.
 *
 * Indexed by ramp month rather than by calendar month, which is the whole point
 * of this shape. A contract says M1 is $4,000 and M8 is $2,705; it does not say
 * when M1 is. Plotting the commitment on a calendar axis means it cannot be
 * drawn at all until somebody records the start month — which is how the
 * previous hero came to render an empty chart against a curve that was fully
 * specified all along.
 */
export type RampPoint = {
  monthIndex: number;
  /** `M3`. The axis label, so no screen constructs it. */
  label: string;
  /** The contracted figure, or null where this month contracts none. */
  target: number | null;
  /**
   * What actually happened in the calendar month this ramp month lands on.
   *
   * Null where the start month is unrecorded — every month, in that case, which
   * is the state Spartan is in — or where the month has not happened yet, or
   * where it happened and nothing was ingested for it.
   */
  actual: number | null;
  /** The calendar month this lands on, or null with no start month recorded. */
  month: MonthKey | null;
  /** Signed distance and its assessment, where both halves exist. */
  gap: TargetGap | null;
};

export type RampSeries = {
  metric: RampMetricKey;
  points: RampPoint[];
  /** True where at least one month contracts a figure for this metric. */
  contracted: boolean;
  /** True where at least one month has an actual to plot. */
  measured: boolean;
  /** The first and last contracted figures, for the one-line summary. */
  first: number | null;
  last: number | null;
};

/**
 * Turn the contracted rows into a plottable series for one metric.
 *
 * `actualFor` is asked for a calendar month and may answer null; it is only
 * ever called where a start month exists, so a screen cannot accidentally
 * align an actual to the wrong month by assuming the engagement began when
 * ingestion did.
 *
 * `direction` decides how a gap is assessed — a cost under target is ahead —
 * and comes from the metric's own declaration rather than from this function,
 * because which way is better is a property of the metric everywhere else too.
 */
export function rampSeries(
  targets: readonly RampTarget[],
  metric: RampMetricKey,
  options: {
    startMonth: MonthKey | null;
    actualFor?: (month: MonthKey) => number | null;
    direction?: ImprovementDirection | null;
  },
): RampSeries {
  const { startMonth, actualFor, direction = null } = options;
  const ordered = [...targets].sort((a, b) => a.monthIndex - b.monthIndex);

  const points = ordered.map((row): RampPoint => {
    const target = row[metric];
    const month = startMonth ? rampMonthKey(startMonth, row.monthIndex) : null;
    const actual = month && actualFor ? actualFor(month) : null;

    return {
      monthIndex: row.monthIndex,
      label: `M${row.monthIndex}`,
      target: target === null || target === undefined ? null : Number(target),
      actual,
      month,
      gap:
        target !== null && target !== undefined && actual !== null && direction
          ? gapToTarget(actual, Number(target), direction)
          : null,
    };
  });

  const contractedValues = points.map((p) => p.target).filter((v): v is number => v !== null);

  return {
    metric,
    points,
    contracted: contractedValues.length > 0,
    measured: points.some((p) => p.actual !== null),
    first: contractedValues[0] ?? null,
    last: contractedValues.at(-1) ?? null,
  };
}

/* ------------------------------------------------------------------------- */
/* The ramp on the calendar, once it has a start                             */
/* ------------------------------------------------------------------------- */

/**
 * One month's actual, as the screen read it.
 *
 * `value` null is "Not measured" and `reason` says why — no spend synced for
 * the month, or too few deals for a cost per deal to mean anything. Never a
 * zero: a month nobody measured is not a month that cost nothing.
 */
export type MonthActual = {
  value: number | null;
  reason: string | null;
  /**
   * The whole cost-per-deal metric behind `value`, where the metric is one —
   * attributed deals, deals credited to no channel, and the plausible range.
   * A cost per deal never renders without them, on a chart or anywhere else.
   */
  cost?: ChannelCostPerDeal;
  /**
   * True where the figure is absent because nothing was there to divide by —
   * "No deals yet" — as opposed to a source that was not read. The two render
   * differently: an empty month is a plain statement, not an amber badge.
   */
  empty?: boolean;
};

export type TimelinePhase = 'baseline' | 'engagement';

/**
 * - `complete`: a finished month with a figure.
 * - `partial`: the month in progress with a figure, which is month-to-date
 *   and is never compared against a monthly target.
 * - `not_measured`: a month that has happened, with no figure.
 * - `future`: a month that has not happened. Not "not measured", because
 *   there is nothing yet to measure.
 */
export type TimelineStatus = 'complete' | 'partial' | 'not_measured' | 'future';

export type TimelinePoint = {
  month: MonthKey;
  phase: TimelinePhase;
  /** 1-based ramp month, or null for a baseline month. */
  monthIndex: number | null;
  /** The contracted figure, engagement months only. */
  target: number | null;
  /** The finished month's figure. Null for partial, unmeasured and future months. */
  actual: number | null;
  /** The month in progress, month to date. Null everywhere else. */
  partial: number | null;
  status: TimelineStatus;
  /**
   * The month in progress, whatever its status. A partial month with too few
   * deals is `not_measured` *and* in progress, and says both.
   */
  inProgress: boolean;
  /** Why a month that has happened has no figure. */
  reason: string | null;
  /** The cost-per-deal metric behind a complete or partial figure, where there is one. */
  cost: ChannelCostPerDeal | null;
  /** Finished engagement months with both halves, and nowhere else. */
  gap: TargetGap | null;
  /**
   * Whether the gap is judged. False for a metric that declares no direction —
   * spend over budget is a fact about pacing, not good or bad news — so its
   * gap is stated as over or under and never coloured.
   */
  assessed: boolean;
};

export type RampTimeline = {
  metric: RampMetricKey;
  startMonth: MonthKey;
  points: TimelinePoint[];
  /** Finished engagement months with a gap, oldest first. */
  finished: TimelinePoint[];
  contracted: boolean;
};

/**
 * The contracted curve on the calendar, with what came before it.
 *
 * Only callable with a start month, which is the reason `rampSeries` stays the
 * M1–Mn shape: until the start is recorded the calendar has nowhere to put the
 * commitment. Once it is, the baseline is the argument — the months before
 * Zeeraa, on the same axis and by the same arithmetic, so the target is read
 * against where the client actually was.
 *
 * `readActual` is asked for every month that has happened, and never for one
 * that has not. The month in progress comes back as `partial`: a ramp
 * contracts a monthly result, and three weeks of one is drawn apart and never
 * assessed against it.
 */
export function rampTimeline(
  targets: readonly RampTarget[],
  metric: RampMetricKey,
  options: {
    startMonth: MonthKey;
    /** Calendar months drawn before M1. */
    baselineMonths: number;
    /** The tenant's current `YYYY-MM`. */
    currentMonth: MonthKey;
    readActual: (month: MonthKey) => MonthActual;
    direction?: ImprovementDirection | null;
  },
): RampTimeline {
  const { startMonth, baselineMonths, currentMonth, readActual, direction = null } = options;
  const ordered = [...targets].sort((a, b) => a.monthIndex - b.monthIndex);
  const lastIndex = ordered.at(-1)?.monthIndex ?? 0;

  const points: TimelinePoint[] = [];
  for (let offset = -Math.max(0, baselineMonths); offset < lastIndex; offset += 1) {
    const month = shiftMonth(startMonth, offset);
    const monthIndex = offset >= 0 ? offset + 1 : null;
    const row = monthIndex === null ? undefined : ordered.find((t) => t.monthIndex === monthIndex);
    const raw = row?.[metric];
    const target = raw === null || raw === undefined ? null : Number(raw);

    let actual: number | null = null;
    let partial: number | null = null;
    let status: TimelineStatus = 'future';
    let reason: string | null = null;
    let cost: ChannelCostPerDeal | null = null;

    if (month <= currentMonth) {
      const read = readActual(month);
      cost = read.value === null ? null : (read.cost ?? null);
      if (read.value === null) {
        status = 'not_measured';
        reason = read.reason;
      } else if (month === currentMonth) {
        status = 'partial';
        partial = read.value;
      } else {
        status = 'complete';
        actual = read.value;
      }
    }

    points.push({
      month,
      phase: monthIndex === null ? 'baseline' : 'engagement',
      monthIndex,
      target,
      actual,
      partial,
      status,
      inProgress: month === currentMonth,
      reason,
      cost,
      gap:
        status === 'complete' && target !== null
          ? direction
            ? gapToTarget(actual!, target, direction)
            : unassessedGap(actual!, target)
          : null,
      assessed: direction !== null,
    });
  }

  return {
    metric,
    startMonth,
    points,
    finished: points.filter((p) => p.gap !== null),
    contracted: points.some((p) => p.target !== null),
  };
}

/** The distance alone, for a metric with no declared direction. */
function unassessedGap(actual: number, target: number): TargetGap {
  return {
    absolute: actual - target,
    relative: target === 0 ? null : (actual - target) / Math.abs(target),
    assessment: 'level',
    target,
    actual,
  };
}

/** `YYYY-MM` moved by a signed number of months. */
function shiftMonth(month: MonthKey, by: number): MonthKey {
  const total = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + by;
  const year = Math.floor(total / 12);
  return `${year}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------------- */
/* One channel's month, as the six contracted figures                        */
/* ------------------------------------------------------------------------- */

/**
 * What a month of one channel contained, whoever read it.
 *
 * The web ramp builds this from a bucket; the baseline freeze builds it from
 * `channelMonth` in `@zeeraa/db`. Either way the figures come from
 * `channelMonthActuals` below, so a frozen month is by construction what the
 * ramp showed for it.
 */
export type ChannelMonthInput = {
  spend: number;
  /** This channel's deals, the deals no channel claims, and every deal, per stage. */
  stages: Record<string, { own: number; unattributed: number; all: number }>;
  ownVolume: number;
  /** The channel's spend coverage of the month (the day ledger). */
  spendCoverage: RangeCoverage;
  /** Whether the CRM has been read for the month at all. */
  crmRead: boolean;
};

const RENDER_DAY = (day: string) => formatRangeLabel({ start: day, end: day });

/**
 * The six contracted figures for one month of one channel.
 *
 * The rules the ramp states on screen, in one place: a ratio takes both halves
 * from the channel and is withheld below its population floor; a finished
 * month must have been read to its last day and the month in progress must
 * have no unread day; a count in a read month is a measurement even at zero.
 * Every figure that is missing says why.
 */
export function channelMonthActuals(
  input: ChannelMonthInput,
  options: {
    month: MonthKey;
    currentMonth: MonthKey;
    /** Display name for reasons: "Google Ads". */
    channel: string;
    valueStage: string | null;
    approvalStage: string;
    /** The smallest denominator a ratio may be drawn over (`min_rate_denominator.render`). */
    renderFloor: number;
  },
): Record<RampMetricKey, MonthActual> {
  const { month, currentMonth, channel, valueStage, approvalStage, renderFloor } = options;
  const cover = input.spendCoverage;

  const spendProblem = (): string | null => {
    if (cover.state === 'never' || cover.state === 'none') return `${channel} spend is not synced for this month.`;
    if (cover.missing.length > 0) {
      return `${channel} spend was not read for ${daySpans(cover.missing).map((span) => formatRangeLabel(span)).join(', ')}.`;
    }
    if (month < currentMonth && cover.pastThrough && cover.through) {
      return `${channel} spend was read only through ${RENDER_DAY(cover.through)}.`;
    }
    return null;
  };
  const crmProblem = input.crmRead ? null : 'Salesforce is not synced for this month.';
  const noValue = 'No funnel stage is configured to count value.';

  const ratio = (stage: string, formulaKey: string): MonthActual => {
    const problem = spendProblem() ?? crmProblem;
    if (problem) return { value: null, reason: problem };
    const counts = input.stages[stage] ?? { own: 0, unattributed: 0, all: 0 };
    // A cost is never withheld for a small denominator (see `population.ts`):
    // only an empty one has no figure, and it says so in the client's words.
    if (counts.own === 0) {
      return { value: null, reason: stage === approvalStage ? 'No approvals yet.' : 'No deals yet.', empty: true };
    }
    const gate = assessPopulation(formulaKey, counts.own, renderFloor);
    if (!gate.sufficient) return { value: null, reason: gate.reason };
    const cost = channelCostPerDeal({
      channelSpend: input.spend,
      attributedDeals: counts.own,
      unattributedDeals: counts.unattributed,
      dealsAttributedElsewhere: Math.max(0, counts.all - counts.own - counts.unattributed),
    });
    return { value: cost.value, reason: null, cost };
  };
  const count = (value: number, needs: 'spend' | 'crm'): MonthActual => {
    const problem = needs === 'spend' ? spendProblem() : crmProblem;
    return problem ? { value: null, reason: problem } : { value, reason: null };
  };

  return {
    costPerFundedDeal: valueStage ? ratio(valueStage, 'cost_per_funded_deal') : { value: null, reason: noValue },
    cpa: ratio(approvalStage, 'cpa'),
    budget: count(input.spend, 'spend'),
    approvals: count(input.stages[approvalStage]?.own ?? 0, 'crm'),
    fundedDeals: valueStage ? count(input.stages[valueStage]?.own ?? 0, 'crm') : { value: null, reason: noValue },
    fundedAmount: valueStage ? count(input.ownVolume, 'crm') : { value: null, reason: noValue },
  };
}
