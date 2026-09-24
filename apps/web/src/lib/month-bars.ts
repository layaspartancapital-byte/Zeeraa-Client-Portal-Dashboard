import type { MonthBar } from '@/components/charts/MonthBars';

/**
 * Monthly counts as labelled bars, with the months that are not whole marked:
 * the first month of the record when it began part-way through (`from Jun
 * 18`), and the month in progress (`month so far`). Server-side, so the
 * client chart takes plain data.
 */
export function monthBars(
  months: { month: string; value: number }[],
  { firstDay, today }: { firstDay: string | null; today: string },
): MonthBar[] {
  const current = today.slice(0, 7);
  return months.map(({ month, value }) => {
    const [y, m] = month.split('-').map(Number);
    const at = new Date(Date.UTC(y!, m! - 1, 1));
    const startsLate = firstDay !== null && firstDay.slice(0, 7) === month && firstDay.slice(8) !== '01';
    return {
      key: month,
      label: at.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
      title: at.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      value,
      partial:
        month === current
          ? 'month so far'
          : startsLate
            ? `from ${new Date(`${firstDay}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`
            : null,
    };
  });
}
