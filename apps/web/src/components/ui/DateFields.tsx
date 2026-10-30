'use client';

import { useState } from 'react';

/**
 * The picker's two date fields, each open to any day up to today.
 *
 * The start's ceiling was the *current* end (`max={range.end}`), so on a page
 * opened on September the start's calendar could not reach October at all —
 * its next-month arrow was disabled (Comparison, 30 October 2026). Here both
 * fields stop at today, and the pair is kept in order as it is picked: a start
 * after the end carries the end with it, and the end cannot go before the
 * start. The server still refuses a reversed pair; this is the affordance.
 */
export function DateFields({
  names,
  start: initialStart,
  end: initialEnd,
  today,
  label,
}: {
  names: { from: string; to: string };
  start: string;
  end: string;
  today: string;
  label?: string;
}) {
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const field = 'h-9 rounded-[8px] border border-border bg-surface px-2 text-[13px] tabular text-text';

  return (
    <>
      <label htmlFor={names.from} className="sr-only">
        {label ? `${label} start date` : 'Start date'}
      </label>
      <input
        id={names.from}
        name={names.from}
        type="date"
        value={start}
        max={today}
        onChange={(e) => {
          const next = e.target.value;
          setStart(next);
          if (next && end && next > end) setEnd(next);
        }}
        className={field}
      />
      <span aria-hidden="true" className="text-[13px] text-text-3">
        –
      </span>
      <label htmlFor={names.to} className="sr-only">
        {label ? `${label} end date` : 'End date'}
      </label>
      <input
        id={names.to}
        name={names.to}
        type="date"
        value={end}
        min={start || undefined}
        max={today}
        onChange={(e) => setEnd(e.target.value)}
        className={field}
      />
    </>
  );
}
