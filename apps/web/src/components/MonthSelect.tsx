'use client';

import { useRouter } from 'next/navigation';
import { Calendar } from 'lucide-react';

/**
 * The month selector.
 *
 * A native select rather than a bespoke popover: it is a list of twelve dates,
 * the platform already renders that well on a phone, and the keyboard and
 * screen-reader behaviour comes free. "Trailing window" is the first option
 * because it is the default the rest of the product uses.
 */
export function MonthSelect({
  base,
  params,
  months,
  active,
}: {
  base: string;
  params: Record<string, string>;
  months: { key: string; label: string }[];
  /** Null when a trailing window is in force rather than a named month. */
  active: string | null;
}) {
  const router = useRouter();

  return (
    <label className="relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[8px] border border-border bg-surface pl-2.5 pr-2 text-[13px] font-medium text-text print-hidden">
      <Calendar aria-hidden="true" className="h-4 w-4 shrink-0 text-text-3" />
      <span className="sr-only">Period</span>
      <select
        value={active ?? 'window'}
        onChange={(event) => {
          const next = new URLSearchParams(params);
          if (event.target.value === 'window') next.delete('month');
          else next.set('month', event.target.value);
          router.push(`${base}?${next.toString()}`, { scroll: false });
        }}
        className="max-w-[10rem] appearance-none bg-transparent py-1 pr-4 text-[13px] font-medium text-text outline-none"
      >
        <option value="window">Trailing window</option>
        {months.map((month) => (
          <option key={month.key} value={month.key}>
            {month.label}
          </option>
        ))}
      </select>
      <span aria-hidden="true" className="pointer-events-none absolute right-2 text-text-3">
        ▾
      </span>
    </label>
  );
}
