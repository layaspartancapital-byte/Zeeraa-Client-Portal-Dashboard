import Link from 'next/link';
import {
  formatRangeLabel,
  rangeLengthDays,
  RANGE_PRESETS,
  type DateRange,
  type RangePresetKey,
} from '@zeeraa/core';

/**
 * The page's date control: two dates, the common ranges beside them, and the
 * resolved period in words.
 *
 * It replaced a 30/90/365 segmented pill, which could say three things, all of
 * them trailing today. "August" and "since the engagement began" had no answer.
 *
 * **A plain GET form, so it works with JavaScript off**, like every other form
 * in this product. Submitting navigates to `?from=&to=`, which is the same
 * shape the presets link to — so a range is bookmarkable, survives a reload,
 * opens in a new tab and is what the CSV export reads. There is no client state
 * here at all.
 *
 * The other search params travel as hidden inputs. A GET form replaces the
 * whole query string, so without them submitting a date would silently drop the
 * attribution model or the selected channel.
 */
export function DateRangePicker({
  range,
  preset,
  presetHref,
  preserve,
  problem,
  earliest,
  today,
}: {
  range: DateRange;
  /** The preset this range corresponds to, where it is one. */
  preset: RangePresetKey | null;
  /** Builds the link for a preset, carrying the page's other params. */
  presetHref: (key: RangePresetKey) => string;
  /** Other search params, so submitting the form does not drop them. */
  preserve: Record<string, string>;
  /** Why the requested range was not used. One line, beneath the control. */
  problem: string | null;
  /**
   * The first day anything was ingested, used as the earliest sensible start.
   * Advisory: a start before it is allowed and renders as "not ingested
   * before …" rather than as zeros, which is the honest treatment.
   */
  earliest: string | null;
  today: string;
}) {
  const days = rangeLengthDays(range);

  return (
    <div data-tour="date-range" className="flex min-w-0 flex-col gap-1.5 print-hidden">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <form method="GET" className="flex shrink-0 items-center gap-1.5">
          {Object.entries(preserve).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}

          <label htmlFor="from" className="sr-only">
            Start date
          </label>
          <input
            id="from"
            name="from"
            type="date"
            defaultValue={range.start}
            // `max` on the start and `min` on the end stop the browser offering
            // a reversed pair at all. The server refuses one anyway — this is
            // the affordance, not the check.
            max={range.end}
            className="h-9 rounded-[8px] border border-border bg-surface px-2 text-[13px] tabular text-text"
          />
          <span aria-hidden="true" className="text-[13px] text-text-3">
            –
          </span>
          <label htmlFor="to" className="sr-only">
            End date
          </label>
          <input
            id="to"
            name="to"
            type="date"
            defaultValue={range.end}
            min={range.start}
            className="h-9 rounded-[8px] border border-border bg-surface px-2 text-[13px] tabular text-text"
          />
          <button
            type="submit"
            className="h-9 rounded-[8px] bg-primary px-3 text-[13px] font-semibold text-white transition-colors hover:bg-primary-600"
          >
            Apply
          </button>
        </form>

        <div
          role="group"
          aria-label="Quick ranges"
          className="inline-flex shrink-0 rounded-[8px] border border-border bg-surface p-[2px]"
        >
          {RANGE_PRESETS.map((option) => {
            const on = option.key === preset;
            return (
              <Link
                key={option.key}
                href={presetHref(option.key)}
                scroll={false}
                aria-current={on ? 'true' : undefined}
                className={`rounded-[6px] px-2 py-1 text-[13px] font-medium tabular transition-colors ${
                  on ? 'bg-primary text-white' : 'text-text-2 hover:text-text'
                }`}
              >
                {option.label}
              </Link>
            );
          })}
        </div>
      </div>

      {/* The period, spelled out. A pill says "90d"; this says which 90 days,
          which is the thing a client repeats back in a meeting. */}
      <p className="text-[12px] tabular text-text-3">
        {formatRangeLabel(range)} · {days} {days === 1 ? 'day' : 'days'}
        {earliest && range.start < earliest && (
          <> · nothing ingested before {earliest}</>
        )}
        {range.end > today && <> · ends in the future</>}
      </p>

      {problem && (
        <p role="status" className="text-[12px] leading-snug text-[#B54708]">
          {problem}
        </p>
      )}
    </div>
  );
}
