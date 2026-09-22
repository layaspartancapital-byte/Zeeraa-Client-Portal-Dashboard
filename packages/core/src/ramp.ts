import { delta, type Delta, type ImprovementDirection } from './format';

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
