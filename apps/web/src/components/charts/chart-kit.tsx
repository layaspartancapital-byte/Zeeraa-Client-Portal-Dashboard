'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Shared chart furniture: the palette, axis defaults, the tooltip card and the
 * first-load animation rule.
 *
 * Kept apart from the charts themselves so the tokens are declared once. A
 * colour that is not in `SERIES` does not appear in a plot area.
 */

/** The ordered categorical palette from spec v2 §4. Assigned by identity. */
export const SERIES = [
  '#3B5BDB',
  '#7C3AED',
  '#06B6D4',
  '#F59E0B',
  '#EC4899',
  '#10B981',
] as const;

export const PRIMARY = '#3B5BDB';
export const PRIMARY_SOFT = '#A9B8F2';
export const PRIMARY_100 = '#E7ECFB';
export const BORDER = '#E6EAF2';
export const TEXT = '#101828';
export const TEXT_2 = '#475467';
/** Axis and tick labels are text, so this is the AA-safe grey, not #98A2B3. */
export const TEXT_3 = '#667085';
export const UP = '#12B76A';
export const DOWN = '#F04438';
/** Outlines on the fills above, so a bar's boundary clears 3:1 on the surface. */
export const UP_EDGE = '#027A48';
export const DOWN_EDGE = '#B42318';
export const WARN = '#F79009';

/**
 * Deals no channel can claim are not given a categorical hue.
 *
 * Handing them a slot beside the channels would undo in the chart exactly what
 * the table's separate row group establishes: they are a population, not a
 * channel, and they have no spend behind them.
 */
export const UNATTRIBUTED = '#98A2B3';

/**
 * A channel keeps its colour by identity, never by rank, so filtering one out
 * never repaints the others.
 */
export function channelColor(platform: string, order: readonly string[]): string {
  const i = order.indexOf(platform);
  return SERIES[(i < 0 ? 0 : i) % SERIES.length]!;
}

export const AXIS = {
  stroke: TEXT_3,
  fontSize: 12,
  tickLine: false,
  axisLine: false,
} as const;

/**
 * Series animate in on first load only (spec v2 §8).
 *
 * "First load" is per chart for the lifetime of the client router, so a filter
 * change — which re-renders the page on the server and remounts the chart — does
 * not replay the entrance. The chart crossfades instead, at 150ms, from the
 * wrapper class.
 */
const animated = new Set<string>();

const ENTRANCE_MS = 400;

export function useFirstLoad(id: string): boolean {
  const [animate, setAnimate] = useState(false);
  const decided = useRef(false);

  useEffect(() => {
    if (decided.current) return;
    decided.current = true;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || animated.has(id)) return;

    animated.add(id);
    setAnimate(true);

    /**
     * Switched back off once the entrance has played.
     *
     * Without this, the charting library replays the entrance every time the
     * container resizes — so dragging a window edge redraws every series from
     * zero, and a chart caught mid-replay looks like a collapse in the metric.
     * Spec v2 §8 allows the entrance once, on first load, and nothing after it.
     */
    const timer = window.setTimeout(() => setAnimate(false), ENTRANCE_MS + 50);
    return () => window.clearTimeout(timer);
  }, [id]);

  return animate;
}

/** White card, shadow, bold value, muted label, date on top. */
export function TooltipCard({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; value: string; color?: string }[];
}) {
  return (
    <div className="rounded-[8px] border border-border bg-surface px-3 py-2 shadow-[var(--shadow-pop)]">
      <p className="text-[12px] font-medium text-text-3">{title}</p>
      <div className="mt-1 space-y-0.5">
        {rows.map((row) => (
          <p key={row.label} className="flex items-center gap-2 text-[12px] tabular">
            {row.color && (
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ background: row.color }}
              />
            )}
            <span className="text-text-2">{row.label}</span>
            <span className="ml-auto font-semibold text-text">{row.value}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

/** A small legend chip row. Names, so a colour is never the only encoding. */
export function Legend({
  items,
}: {
  items: { label: string; color: string; dashed?: boolean }[];
}) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 text-[12px] text-text-2">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{
              background: item.dashed ? 'transparent' : item.color,
              border: item.dashed ? `2px dashed ${item.color}` : undefined,
            }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * The table behind every chart.
 *
 * Visually hidden rather than behind a toggle: spec v2 §2 will not have a
 * control on screen that exists only to restate the plot, and a screen-reader
 * user still needs the numbers. It prints, too.
 */
export function ChartTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: (string | number)[][];
}) {
  /*
    The `sr-only` class goes on a wrapper, not on the table.
    `sr-only` works by collapsing the box to 1px and hiding the overflow, and a
    `display: table` box ignores that: it lays out to its content width
    regardless, so the table stayed invisible and still widened the document by
    a couple of hundred pixels — a horizontal page scroll with nothing visible
    causing it.
  */
  return (
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
