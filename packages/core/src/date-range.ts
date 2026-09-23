import {
  addDays,
  eachDay,
  monthRange,
  previousMonth,
  trailingWindow,
  type DateRange,
} from './dates';

/**
 * The page's date range: an exact pair of days, with presets for the common
 * ones.
 *
 * It replaced a 30/90/365 segmented control. That control could only express
 * three windows, all of them trailing today, so "the client asked about
 * August" had no answer and "since the engagement started" had none either.
 * The range is now two days in the URL, which keeps every property the old one
 * had — bookmarkable, survives a reload, and the CSV export reads the same
 * params the page did — and adds the ones it lacked.
 *
 * Resolution lives here rather than on each page because five screens read it
 * and they must not disagree about what `?from=&to=` means.
 */

export type RangePresetKey = 'today' | '7d' | '30d' | '90d' | 'mtd' | 'all';

export const RANGE_PRESETS: { key: RangePresetKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: 'mtd', label: 'MTD' },
  { key: 'all', label: 'All time' },
];

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day, not merely the right shape: 2026-02-31 is neither. */
export function isDay(value: string | undefined | null): value is string {
  if (!value || !ISO_DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * The longest range the screens will draw.
 *
 * Not arithmetic — three years of monthly buckets is thirty-six columns, which
 * no chart here reads well, and a typo of `2026` as `2016` should not put a
 * decade of empty buckets through every query on the page. Reported rather
 * than silently trimmed.
 */
export const MAX_RANGE_DAYS = 1096;

export function rangeLengthDays(range: DateRange): number {
  const ms =
    new Date(`${range.end}T00:00:00Z`).getTime() - new Date(`${range.start}T00:00:00Z`).getTime();
  return Math.floor(ms / 86_400_000) + 1;
}

/**
 * A preset, resolved against the tenant's today.
 *
 * `all` needs the first day anything was ingested. With nothing ingested there
 * is no "all" to show, so it falls back to the default window rather than
 * inventing a start — a range beginning at the epoch would draw sixty years of
 * nothing.
 */
export function presetRange(
  key: RangePresetKey,
  today: string,
  earliest: string | null,
): DateRange {
  switch (key) {
    case 'today':
      return { start: today, end: today };
    case '7d':
      return trailingWindow(today, 7);
    case '30d':
      return trailingWindow(today, 30);
    case '90d':
      return trailingWindow(today, 90);
    case 'mtd':
      return { start: monthRange(today.slice(0, 7)).start, end: today };
    case 'all':
      return { start: earliest && earliest <= today ? earliest : trailingWindow(today, 90).start, end: today };
  }
}

/** Which preset a range *is*, so the control can show one as active. */
export function matchPreset(
  range: DateRange,
  today: string,
  earliest: string | null,
): RangePresetKey | null {
  for (const { key } of RANGE_PRESETS) {
    const candidate = presetRange(key, today, earliest);
    if (candidate.start === range.start && candidate.end === range.end) return key;
  }
  return null;
}

export type ResolvedRange = {
  range: DateRange;
  /** The preset this range corresponds to, where it is one. */
  preset: RangePresetKey | null;
  /**
   * Why the requested range was not used, where it was not. One sentence, for
   * the screen to render — the range still resolves to something, because a
   * page with no range is a blank page.
   */
  problem: string | null;
};

/**
 * Turns the URL into a range.
 *
 * Order matters: an explicit `from`/`to` beats a preset, a preset beats the
 * legacy `days`, and the default is the 90 days the old control opened on.
 *
 * `days` is still read so that links made before this existed — a bookmark, a
 * CSV export URL someone saved — keep working rather than silently resolving
 * to something else.
 */
export function resolveDateRange(input: {
  from?: string | null;
  to?: string | null;
  preset?: string | null;
  days?: string | null;
  today: string;
  earliest: string | null;
}): ResolvedRange {
  const { today, earliest } = input;
  const fallback = (problem: string | null): ResolvedRange => ({
    range: presetRange('90d', today, earliest),
    preset: '90d',
    problem,
  });

  if (input.from || input.to) {
    if (!isDay(input.from) || !isDay(input.to)) {
      return fallback('That date range was not a pair of dates, so the last 90 days are shown.');
    }
    if (input.from > input.to) {
      // Not swapped. Swapping decides what somebody meant, and the two dates
      // being the wrong way round is as likely to be the wrong field filled in
      // as a transposition.
      return fallback('The start date was after the end date, so the last 90 days are shown.');
    }
    const range = { start: input.from, end: input.to };
    if (rangeLengthDays(range) > MAX_RANGE_DAYS) {
      return fallback(
        `A range longer than ${Math.floor(MAX_RANGE_DAYS / 365)} years is not drawn, so the last 90 days are shown.`,
      );
    }
    return { range, preset: matchPreset(range, today, earliest), problem: null };
  }

  const preset = RANGE_PRESETS.find((p) => p.key === input.preset);
  if (preset) {
    return { range: presetRange(preset.key, today, earliest), preset: preset.key, problem: null };
  }

  const legacy = Number(input.days);
  if (Number.isFinite(legacy) && legacy >= 1 && legacy <= 365) {
    const range = trailingWindow(today, Math.floor(legacy));
    return { range, preset: matchPreset(range, today, earliest), problem: null };
  }

  return fallback(null);
}

/**
 * The range in words, so the period on screen is never inferred from a pill.
 *
 * `Jun 21 – Sep 21, 2026`, with the year stated once where both ends share it
 * and twice where they do not. `en-US` because every other date in this product
 * is — `bucketLabel` writes the axis beneath this text, and en-GB would put
 * "Sept" under a "Sep".
 */
export function formatRangeLabel(range: DateRange, locale = 'en-US'): string {
  const day = (value: string, withYear: boolean) =>
    new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      year: withYear ? 'numeric' : undefined,
      timeZone: 'UTC',
    }).format(new Date(`${value}T00:00:00Z`));

  if (range.start === range.end) return day(range.start, true);
  const sameYear = range.start.slice(0, 4) === range.end.slice(0, 4);
  return `${day(range.start, !sameYear)} – ${day(range.end, true)}`;
}

/**
 * Month buckets for a long range, week buckets for a medium one, day buckets
 * for a short one.
 *
 * A seven-day range drawn in months is one column, which is not a series. The
 * upper boundary is ten weeks: below it a month chart has at most three points.
 * The lower one is three weeks, where a weekly chart is down to two columns and
 * the range is short enough that a day is a legible unit — a single-day range
 * resolves to one day bucket, which the charts draw as a point rather than as a
 * line.
 */
export function granularityFor(range: DateRange): 'month' | 'week' | 'day' {
  const days = rangeLengthDays(range);
  if (days >= 70) return 'month';
  return days >= 21 ? 'week' : 'day';
}

/** The day before a range, back the same length — the comparison baseline. */
export function precedingRange(range: DateRange): DateRange {
  const length = rangeLengthDays(range);
  const end = addDays(range.start, -1);
  return { start: addDays(end, -(length - 1)), end };
}

/* ------------------------------------------------------------------------- */
/* The briefing's fixed periods                                              */
/* ------------------------------------------------------------------------- */

export type BriefingPeriods = {
  /** The first of this month to today, inclusive. */
  monthToDate: DateRange;
  /** The whole of the month before this one. */
  lastFullMonth: DateRange;
  /** `2026-09`, for the ramp's month arithmetic. */
  currentMonth: string;
  /** Days of this month elapsed, inclusive of today. */
  elapsedDays: number;
  /** Days this month holds. */
  monthDays: number;
  /**
   * The elapsed share of the month, for pacing.
   *
   * Inclusive of today, because a budget is spent across today as well —
   * measuring to yesterday would report every account as underspending by one
   * day's worth on every day of the month.
   */
  elapsed: number;
};

/**
 * The two periods the executive briefing reads, resolved once.
 *
 * The briefing has no date control: it is a standing report rather than a
 * question somebody scopes, so every block states its own period in words and
 * none of them can disagree about what it covers. These are the two, and they
 * are deliberately not the same length — month to date against the last whole
 * month is how a business talks about its own month, and the length difference
 * is handled by never putting a *count* from one beside a count from the other
 * as a delta. Rates and costs compare fine, because neither scales with the
 * number of days.
 */
export function briefingPeriods(today: string): BriefingPeriods {
  const currentMonth = today.slice(0, 7);
  const current = monthRange(currentMonth);
  const previous = monthRange(previousMonth(currentMonth));

  const monthDays = rangeLengthDays(current);
  const elapsedDays = Number(today.slice(8, 10));

  return {
    monthToDate: { start: current.start, end: today },
    lastFullMonth: previous,
    currentMonth,
    elapsedDays,
    monthDays,
    elapsed: monthDays === 0 ? 0 : elapsedDays / monthDays,
  };
}

/**
 * How much of a range a source has actually been read for.
 *
 * `through` is the tenant-local day of the source's last read, or null when it
 * has never delivered. `unread` is the days *inside* the record that were never
 * read — the ledger's gaps (migration 0030). The range is:
 *
 *   * `full` — every day of it has been read;
 *   * `partial` — some of it has: it runs past the last read, or has unread
 *     days inside it, so its figures are real but incomplete and must say
 *     which days are missing;
 *   * `none` — none of it has: it starts after the last read, or every day in
 *     it is unread, so a figure would be a zero standing in for "not measured";
 *   * `never` — the source has never delivered.
 *
 * Unread days used to be invisible here: coverage was decided from the last
 * read alone, so Meta's unread 19–20 September 2026 rendered as two quiet days
 * inside a "fully synced" month.
 *
 * Today counts as read when the last read was today: the freshness strip
 * already says "as of" the hour, and treating every month-to-date range as
 * partial would put a caveat on every screen for a gap of minutes.
 */
export type RangeCoverage = {
  state: 'full' | 'partial' | 'none' | 'never';
  through: string | null;
  /** Unread days inside the range and the record, ascending. */
  missing: string[];
  /** Whether the range runs past the last read, as distinct from a hole inside it. */
  pastThrough: boolean;
};

export function rangeCoverage(
  range: DateRange,
  through: string | null,
  unread: readonly string[] = [],
): RangeCoverage {
  if (through === null) return { state: 'never', through, missing: [], pastThrough: true };
  if (range.start > through) return { state: 'none', through, missing: [], pastThrough: true };
  const pastThrough = range.end > through;
  const lastRead = range.end < through ? range.end : through;
  const missing = [...new Set(unread)]
    .filter((d) => d >= range.start && d <= lastRead)
    .sort();
  const readable = eachDay({ start: range.start, end: lastRead }).length;
  if (missing.length >= readable) return { state: 'none', through, missing, pastThrough };
  if (missing.length > 0 || pastThrough) return { state: 'partial', through, missing, pastThrough };
  return { state: 'full', through, missing, pastThrough };
}

/**
 * Unread days as a person reads them: consecutive days as one span.
 * `['2026-09-19', '2026-09-20', '2026-09-23']` → `[{19–20 Sep}, {23 Sep}]`.
 */
export function daySpans(days: readonly string[]): DateRange[] {
  const sorted = [...new Set(days)].sort();
  const spans: DateRange[] = [];
  for (const day of sorted) {
    const last = spans.at(-1);
    if (last && addDays(last.end, 1) === day) last.end = day;
    else spans.push({ start: day, end: day });
  }
  return spans;
}
