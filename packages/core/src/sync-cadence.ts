/**
 * When Salesforce is read, and when an open dashboard re-reads it.
 *
 * Every ten minutes while the desk is open, hourly otherwise. The ten-minute
 * read exists because deals move while somebody is watching; at 2am on a
 * Sunday nobody is, and a read every ten minutes then only keeps the database
 * awake — Neon suspends a compute after five idle minutes, so a ten-minute
 * cadence left it running about half of every night, and the Free plan's
 * compute allowance is monthly.
 *
 * The desk's hours are the tenant's `lead_response_hours` row, the same clock
 * speed to lead runs on. A tenant without one is on the 24/7 clock and keeps
 * the ten-minute cadence around the clock, which is what it had before.
 *
 * Both halves are here so the cron route and the page cannot disagree: the
 * page's off-hours refresh lands two minutes past the hour, just after the
 * hourly sync, so the tab reads fresh data and wakes the database once an
 * hour rather than twice.
 */
import { parseWallClock, tenantDay } from './dates';
import type { BusinessHours, Weekday } from './business-hours';

/** Minutes between reads while the desk is open. */
export const BUSINESS_HOURS_CADENCE_MINUTES = 10;

/** UTC minute past the hour of an open page's off-hours refresh. */
export const OFF_HOURS_REFRESH_MINUTE = 2;

const WEEKDAYS: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MINUTE = 60_000;
const STEP = BUSINESS_HOURS_CADENCE_MINUTES * MINUTE;

/**
 * Whether the desk is open at `at`. Null hours is the 24/7 clock: always open.
 *
 * Open at the opening minute, closed at the closing one, on a configured day
 * that is not a holiday — all in the tenant's zone, so 9am stays 9am across a
 * clock change.
 */
export function withinBusinessHours(at: Date, hours: BusinessHours | null): boolean {
  if (hours === null) return true;
  const day = tenantDay(at, hours.timezone);
  const [y, m, d] = day.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
  if (!hours.days.includes(weekday) || hours.holidays.includes(day)) return false;
  const opens = parseWallClock(`${day} ${hours.open}`, hours.timezone)!.getTime();
  const closes = parseWallClock(`${day} ${hours.close}`, hours.timezone)!.getTime();
  return at.getTime() >= opens && at.getTime() < closes;
}

/**
 * Whether a Salesforce cron tick at `at` should read this tenant.
 *
 * The first tick of every hour reads every tenant — that is the hourly floor —
 * and the others read only a tenant whose desk is open. "First tick" is the
 * UTC minute: the crons fire every ten minutes inside the business-hours
 * envelope and on the hour outside it, so minute 0–9 is the tick that exists
 * in every hour. `vercel.json`'s test holds the schedule to that.
 */
export function salesforceSyncDue(at: Date, hours: BusinessHours | null): boolean {
  return at.getUTCMinutes() < BUSINESS_HOURS_CADENCE_MINUTES || withinBusinessHours(at, hours);
}

/**
 * When a page drawn at `last` should next refresh itself.
 *
 * Ten minutes on while the desk is open. Otherwise the next hh:02 at least ten
 * minutes on — unless the desk opens first, in which case the first ten-minute
 * step inside the opening, so a tab left overnight is current by 9:10, not
 * 10:02.
 */
export function nextRefreshAt(last: Date, hours: BusinessHours | null): Date {
  const earliest = last.getTime() + STEP;
  const hourly = new Date(earliest);
  hourly.setUTCMinutes(OFF_HOURS_REFRESH_MINUTE, 0, 0);
  if (hourly.getTime() < earliest) hourly.setUTCHours(hourly.getUTCHours() + 1);

  for (let t = earliest; t < hourly.getTime(); t += STEP) {
    if (withinBusinessHours(new Date(t), hours)) return new Date(t);
  }
  return hourly;
}
