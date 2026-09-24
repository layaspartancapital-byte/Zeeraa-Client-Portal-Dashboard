import type { MonthBar } from '@/components/charts/MonthBars';

const fmtDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

/**
 * Monthly counts as labelled bars, with the months that are not whole marked:
 * a first month that begins part-way through (`from Jun 27`), a last month
 * that ends early (`to Sep 20`), and the month in progress (`month so far`).
 * Server-side, so the client chart takes plain data.
 *
 * `lastDay` is the end of the window the counts cover. Omitted, only the month
 * in progress is marked at the end — the old behaviour, for series that run to
 * today.
 */
export function monthBars(
  months: { month: string; value: number }[],
  { firstDay, lastDay = null, today }: { firstDay: string | null; lastDay?: string | null; today: string },
): MonthBar[] {
  const current = today.slice(0, 7);
  return months.map(({ month, value }) => {
    const [y, m] = month.split('-').map(Number);
    const at = new Date(Date.UTC(y!, m! - 1, 1));
    const startsLate = firstDay !== null && firstDay.slice(0, 7) === month && firstDay.slice(8) !== '01';
    const endsEarly = lastDay !== null && lastDay.slice(0, 7) === month && lastDay < lastDayOf(month);
    const inProgress = month === current && (lastDay === null || lastDay >= today);
    const parts = [
      startsLate ? `from ${fmtDay(firstDay!)}` : null,
      inProgress ? 'month so far' : endsEarly ? `to ${fmtDay(lastDay!)}` : null,
    ].filter(Boolean);
    return {
      key: month,
      label: at.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
      title: at.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      value,
      partial: parts.length > 0 ? parts.join(', ') : null,
    };
  });
}

/** Every `YYYY-MM` a window touches, in order. */
export function monthsOf(range: { start: string; end: string }): string[] {
  const out: string[] = [];
  let [y, m] = range.start.slice(0, 7).split('-').map(Number) as [number, number];
  const end = range.end.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push(key);
    if (key >= end) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
