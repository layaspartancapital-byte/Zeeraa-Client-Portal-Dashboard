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
