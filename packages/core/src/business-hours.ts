/**
 * The clock a response time is measured on.
 *
 * Speed to lead on a 24/7 clock charges the desk for the night: a lead that
 * arrives at 7pm on a Friday and is rung at 9:02 on Monday waited 62 hours by
 * the wall and two minutes by the desk. Which of those is the desk's number is
 * a fact about the client's staffing, so the hours are a config row
 * (`lead_response_hours`) and this is only the arithmetic.
 *
 * The rule is the one a desk is held to:
 *
 *   * **The clock runs only while the desk is open.** A lead that arrives
 *     outside hours starts its clock at the next opening.
 *   * **A call before the opening is a zero wait**, not a negative one. The
 *     desk got to it before the clock started.
 *   * **A holiday is a closed day**, whole, in the tenant's timezone.
 *
 * Opening and closing are wall-clock times in the configured zone, resolved per
 * day through `parseWallClock`, so a DST change moves the instant and not the
 * hour: 9am is 9am in March and in November.
 */
import { addDays, parseWallClock, tenantDay } from './dates';

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

const WEEKDAYS: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEK_ORDER: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export type BusinessHours = {
  /** IANA zone the hours are stated in. */
  timezone: string;
  /** Days the desk is open. */
  days: readonly Weekday[];
  /** Opening, `HH:MM`, 24-hour, in `timezone`. */
  open: string;
  /** Closing, `HH:MM`, 24-hour, after `open`. */
  close: string;
  /** Closed days, `YYYY-MM-DD` in `timezone`. */
  holidays: readonly string[];
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function minutesOf(hhmm: string): number {
  const [, h, m] = HHMM.exec(hhmm)!;
  return Number(h) * 60 + Number(m);
}

function validZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The `lead_response_hours` row, or null when it is absent or malformed.
 *
 * Null rather than a default: an unreadable row falls back to the 24/7 clock,
 * which the card then labels as 24/7 — a figure on the wrong clock with the
 * right label is recoverable, a figure on a guessed clock is not.
 */
export function parseBusinessHours(value: unknown): BusinessHours | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;

  const timezone = v.timezone;
  const open = v.open;
  const close = v.close;
  if (typeof timezone !== 'string' || !validZone(timezone)) return null;
  if (typeof open !== 'string' || !HHMM.test(open)) return null;
  if (typeof close !== 'string' || !HHMM.test(close)) return null;
  if (minutesOf(close) <= minutesOf(open)) return null;

  if (!Array.isArray(v.days) || v.days.length === 0) return null;
  if (!v.days.every((d): d is Weekday => WEEKDAYS.includes(d as Weekday))) return null;

  const holidays = v.holidays ?? [];
  if (!Array.isArray(holidays)) return null;
  if (!holidays.every((d) => typeof d === 'string' && DAY.test(d))) return null;

  return {
    timezone,
    days: WEEK_ORDER.filter((d) => (v.days as Weekday[]).includes(d)),
    open,
    close,
    holidays: [...(holidays as string[])].sort(),
  };
}

function weekdayOf(day: string): Weekday {
  const [y, m, d] = day.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
}

/**
 * Seconds between two instants that fall inside business hours.
 *
 * Zero when `end` is not after `start`, and zero when the whole interval sits
 * outside hours — which is what makes a lead rung before the opening a zero
 * wait rather than a negative one.
 */
export function businessSecondsBetween(start: Date, end: Date, hours: BusinessHours): number {
  const from = start.getTime();
  const to = end.getTime();
  if (!(to > from)) return 0;

  const holidays = new Set(hours.holidays);
  const firstDay = tenantDay(start, hours.timezone);
  const lastDay = tenantDay(end, hours.timezone);
  /*
   * A day strictly between the first and the last is wholly inside the
   * interval, so an open one contributes its full length and needs no
   * wall-clock resolution. The length is the configured one because clocks
   * change at 2am, outside any hours a desk keeps — which is also what makes a
   * lead left for a month cost a month of calendar arithmetic rather than a
   * month of timezone lookups.
   */
  const fullDay = (minutesOf(hours.close) - minutesOf(hours.open)) * 60_000;
  let total = 0;

  for (let day = firstDay; day <= lastDay; day = addDays(day, 1)) {
    if (!hours.days.includes(weekdayOf(day)) || holidays.has(day)) continue;
    if (day !== firstDay && day !== lastDay) {
      total += fullDay;
      continue;
    }
    const opens = parseWallClock(`${day} ${hours.open}`, hours.timezone)!.getTime();
    const closes = parseWallClock(`${day} ${hours.close}`, hours.timezone)!.getTime();
    const overlap = Math.min(to, closes) - Math.max(from, opens);
    if (overlap > 0) total += overlap;
  }

  return Math.round(total / 1000);
}

/**
 * The response time for one lead, on the tenant's clock.
 *
 * `hours` null is the 24/7 clock. Both clocks go through here so a screen that
 * shows one beside the other cannot have computed them by different rules.
 */
export function responseSeconds(
  created: Date,
  firstCall: Date,
  hours: BusinessHours | null,
): number {
  if (hours === null) return Math.round((firstCall.getTime() - created.getTime()) / 1000);
  return businessSecondsBetween(created, firstCall, hours);
}

const DAY_LABEL: Record<Weekday, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

function hourLabel(hhmm: string): string {
  const minutes = minutesOf(hhmm);
  const h = Math.floor(minutes / 60) % 12 || 12;
  const m = minutes % 60;
  return m === 0 ? String(h) : `${h}:${String(m).padStart(2, '0')}`;
}

function zoneLabel(timeZone: string): string {
  // `shortGeneric` is "ET" rather than "EDT"/"EST": the hours are the same
  // wall-clock hours all year, so the label should not change in March.
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortGeneric' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    if (part) return part;
  } catch {
    // Fall through to the zone's own name.
  }
  return timeZone;
}

function daysLabel(days: readonly Weekday[]): string {
  const indices = days.map((d) => WEEK_ORDER.indexOf(d));
  const contiguous = indices.every((n, i) => i === 0 || n === indices[i - 1]! + 1);
  if (contiguous && days.length > 2) {
    return `${DAY_LABEL[days[0]!]}–${DAY_LABEL[days.at(-1)!]}`;
  }
  return days.map((d) => DAY_LABEL[d]).join(', ');
}

/**
 * The clock, in words: "business hours · 9–6 ET, Mon–Fri", or "24/7".
 *
 * Rendered beside every figure measured on it, because a response time is only
 * as meaningful as the clock that produced it.
 */
export function clockLabel(hours: BusinessHours | null): string {
  if (hours === null) return '24/7';
  return `business hours · ${hourLabel(hours.open)}–${hourLabel(hours.close)} ${zoneLabel(
    hours.timezone,
  )}, ${daysLabel(hours.days)}`;
}
