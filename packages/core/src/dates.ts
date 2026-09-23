/**
 * Dates are normalised into the tenant's timezone at ingest, never at query
 * time (§6). A row in `daily_metrics` is already a tenant-local calendar day,
 * so reporting queries never apply a timezone shift and two screens can never
 * disagree about which day a click belonged to.
 */

export type DateRange = { start: string; end: string };

/*
 * Formatters, one per zone.
 *
 * Constructing an `Intl.DateTimeFormat` costs far more than using one — a
 * business-hours response time resolves two wall-clock times per day of wait,
 * and building the formatter each time made a page of speed to lead take
 * seconds. The options never vary, so the zone is the whole key.
 */
const dayFormats = new Map<string, Intl.DateTimeFormat>();
const offsetFormats = new Map<string, Intl.DateTimeFormat>();

function dayFormat(timeZone: string): Intl.DateTimeFormat {
  let format = dayFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormats.set(timeZone, format);
  }
  return format;
}

function offsetFormat(timeZone: string): Intl.DateTimeFormat {
  let format = offsetFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    offsetFormats.set(timeZone, format);
  }
  return format;
}

/** Instant → the tenant-local calendar day, as `YYYY-MM-DD`. */
export function tenantDay(instant: Date, timeZone: string): string {
  const parts = dayFormat(timeZone).formatToParts(instant);
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

/**
 * A wall-clock timestamp with no zone, read as the tenant's local time.
 *
 * Aloware's export writes `2026-06-19 11:32:04` — no offset, no `Z`. Handing
 * that to `new Date()` parses it in the *server's* zone, which in a container
 * is UTC, so every call would land four or five hours late. Speed to lead is a
 * subtraction between a CRM timestamp and a call timestamp, so a constant
 * four-hour error does not look like an error: it looks like a desk that never
 * answers the phone.
 *
 * §16 says dates are normalised into the tenant timezone at ingest. This is
 * the function that does it for a vendor that exports without one.
 *
 * Two passes, which is the standard way to invert a zone lookup without a
 * library: guess that the wall time is UTC, ask what that instant's offset
 * actually is in the target zone, correct, then re-check — the second pass
 * matters only for the hour either side of a DST transition, where the first
 * guess can land on the wrong side of the shift.
 */
export function parseWallClock(text: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text.trim());
  if (!match) return null;

  const [, y, mo, d, h, mi, s] = match;
  const asUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? '0'),
  );
  if (!Number.isFinite(asUtc)) return null;

  let instant = asUtc;
  for (let pass = 0; pass < 2; pass += 1) {
    const offset = zoneOffsetMs(new Date(instant), timeZone);
    const next = asUtc - offset;
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant);
}

/** How far ahead of UTC the zone is at this instant, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = offsetFormat(timeZone).formatToParts(instant);

  const field = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // `hour12: false` renders midnight as 24 in some engines.
  const hour = field('hour') % 24;
  const asIfUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    hour,
    field('minute'),
    field('second'),
  );
  return asIfUtc - instant.getTime();
}
