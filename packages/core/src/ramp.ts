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
