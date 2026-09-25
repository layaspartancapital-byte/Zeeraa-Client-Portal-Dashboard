/**
 * When something happened, in the tenant's timezone, as the People screen says
 * it: minutes for the last hour, "Today" for the rest of the tenant's day, a
 * date after that. Pure, so it is tested without a clock.
 */

function dayKey(at: Date, timeZone: string): string {
  return at.toLocaleDateString('en-CA', { timeZone });
}

function clock(at: Date, timeZone: string): string {
  return at.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
}

export function formatWhen(at: Date, now: Date, timeZone: string): string {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (dayKey(at, timeZone) === dayKey(now, timeZone)) return `Today, ${clock(at, timeZone)}`;
  const sameYear =
    at.toLocaleDateString('en-US', { timeZone, year: 'numeric' }) ===
    now.toLocaleDateString('en-US', { timeZone, year: 'numeric' });
  const date = at.toLocaleDateString('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  return `${date}, ${clock(at, timeZone)}`;
}

/** The full instant, for a tooltip. */
export function formatInstant(at: Date, timeZone: string): string {
  return at.toLocaleString('en-US', {
    timeZone,
    // Not dateStyle/timeStyle: neither combines with timeZoneName, and a
    // tooltip without the zone does not say which 3 PM.
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}
