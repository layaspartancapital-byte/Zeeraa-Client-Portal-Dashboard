/**
 * Dates are normalised into the tenant's timezone at ingest, never at query
 * time (§6). A row in `daily_metrics` is already a tenant-local calendar day,
 * so reporting queries never apply a timezone shift and two screens can never
 * disagree about which day a click belonged to.
 */

export type DateRange = { start: string; end: string };

/** Instant → the tenant-local calendar day, as `YYYY-MM-DD`. */
export function tenantDay(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The trailing 90-day window the nightly ad-platform sync re-pulls (§7). */
export function trailingWindow(today: string, days: number): DateRange {
  return { start: addDays(today, -(days - 1)), end: today };
}

export function monthRange(month: string): DateRange {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) throw new Error(`Invalid month: ${month}`);
  const start = `${month}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { start, end };
}

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) throw new Error(`Invalid month: ${month}`);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

export function eachDay(range: DateRange): string[] {
  const out: string[] = [];
  for (let d = range.start; d <= range.end; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * A bucket of days inside a window.
 *
 * The dashboards plot a window as a series, and the granularity has to be a
 * property of the window rather than of the chart: a cost per funded deal with
 * one or two deals a month cannot be bucketed by day without producing a line
 * that is mostly gaps, and a twelve-month window cannot be bucketed by week
 * without producing fifty-two illegible columns.
 */
export type DayBucket = { key: string; start: string; end: string };

/** Calendar months intersecting the range, clipped to it. */
export function monthBucketsIn(range: DateRange): DayBucket[] {
  const buckets: DayBucket[] = [];
  let month = range.start.slice(0, 7);
  const last = range.end.slice(0, 7);

  while (month <= last) {
    const full = monthRange(month);
    buckets.push({
      key: month,
      start: full.start > range.start ? full.start : range.start,
      end: full.end < range.end ? full.end : range.end,
    });
    const [y, m] = month.split('-').map(Number);
    month = new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 7);
  }
  return buckets;
}

/**
 * Fixed-length buckets aligned to the end of the range, so the most recent
 * bucket is always complete and the clipped one is the oldest. A chart whose
 * right-hand column is a partial period reads as a collapse in the metric.
 */
export function evenBucketsIn(range: DateRange, days: number): DayBucket[] {
  if (days < 1) throw new Error(`Bucket length must be at least one day: ${days}`);
  const buckets: DayBucket[] = [];
  let end = range.end;

  while (end >= range.start) {
    const start = addDays(end, -(days - 1));
    buckets.unshift({
      key: start > range.start ? start : range.start,
      start: start > range.start ? start : range.start,
      end,
    });
    end = addDays(start, -1);
  }
  return buckets;
}

/** The window of the same length immediately before this one. */
export function previousRange(range: DateRange): DateRange {
  const length = Math.round(
    (new Date(`${range.end}T00:00:00Z`).getTime() -
      new Date(`${range.start}T00:00:00Z`).getTime()) /
      86_400_000,
  ) + 1;
  return { start: addDays(range.start, -length), end: addDays(range.start, -1) };
}

/** `Jun 20` / `Jun 2026`, from a bucket, for an axis tick. */
export function bucketLabel(bucket: DayBucket, granularity: 'month' | 'day'): string {
  const date = new Date(`${bucket.start}T00:00:00Z`);
  return granularity === 'month'
    ? date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * The window covering the last `months` calendar months, ending today.
 *
 * Starts on the first of the earliest month rather than this day-of-month a
 * year ago, so the oldest bucket in a monthly series is a whole month. A chart
 * whose left-hand column is eleven days of a month reads as a ramp that never
 * happened.
 */
export function trailingMonths(today: string, months: number): DateRange {
  if (months < 1) throw new Error(`Need at least one month: ${months}`);
  let key = today.slice(0, 7);
  for (let i = 1; i < months; i += 1) key = previousMonth(key);
  return { start: `${key}-01`, end: today };
}
