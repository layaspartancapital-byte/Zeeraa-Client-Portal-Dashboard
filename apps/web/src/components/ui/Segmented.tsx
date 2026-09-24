import Link from 'next/link';

/**
 * A segmented pill: the active segment is a blue fill with white text.
 *
 * Every option is a real link carrying the whole query string, so a filter is
 * bookmarkable, survives a reload, opens in a new tab, and needs no client
 * state. That is also what lets the CSV export match the active filters — it
 * reads the same search params the page did.
 */
export type Segment = { key: string; label: string; href: string };

export function Segmented({
  options,
  active,
  label,
  className = '',
}: {
  options: Segment[];
  active: string;
  /** Names the group for assistive technology, e.g. "Attribution model". */
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`inline-flex h-9 shrink-0 items-center rounded-[8px] border border-border bg-surface p-[2px] print-hidden ${className}`}
    >
      {options.map((option) => {
        const on = option.key === active;
        return (
          <Link
            key={option.key}
            href={option.href}
            scroll={false}
            aria-current={on ? 'true' : undefined}
            className={`rounded-[6px] px-2.5 py-1 text-[13px] font-medium tabular transition-colors ${
              on ? 'bg-primary text-white' : 'text-text-2 hover:text-text'
            }`}
          >
            {option.label}
          </Link>
        );
      })}
    </div>
  );
}

/** Builds a segment list that preserves every param except the one it sets. */
export function segments(
  base: string,
  params: Record<string, string>,
  key: string,
  options: { key: string; label: string }[],
): Segment[] {
  return options.map((option) => {
    const next = new URLSearchParams({ ...params, [key]: option.key });
    return { ...option, href: `${base}?${next.toString()}` };
  });
}
