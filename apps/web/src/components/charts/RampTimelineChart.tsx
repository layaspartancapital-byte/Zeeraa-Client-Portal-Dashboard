'use client';

import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AXIS,
  BORDER,
  ChartTable,
  DOWN,
  PLOT,
  TEXT_2,
  TEXT_3,
  TooltipCard,
  UP,
  WARN,
  useFirstLoad,
} from '@/components/charts/chart-kit';
import { axisFormatter, formatter, type FormatSpec } from '@/components/charts/format-spec';

export type RampTimelineChartPoint = {
  /** `2026-10`. The category key. */
  key: string;
  /** `Oct`, or `Jan ’27` where the year turns. */
  label: string;
  /** `M1 · Oct 2026`, or `Jun 2026 · baseline`. */
  title: string;
  phase: 'baseline' | 'engagement';
  target: number | null;
  /** A finished month's figure. */
  actual: number | null;
  /** The month in progress, month to date. */
  partial: number | null;
  status: 'complete' | 'partial' | 'not_measured' | 'future';
  /** The month in progress, whether or not it has a figure yet. */
  inProgress: boolean;
  reason: string | null;
  gap: { absolute: number; assessment: 'ahead' | 'shortfall' | 'level' } | null;
  /** False where the metric declares no direction: the gap is stated, not judged. */
  assessed: boolean;
};

type Row = RampTimelineChartPoint & {
  /** Last finished figure and the partial one, so a dotted link joins them. */
  partialLink: number | null;
  /** `[actual, target]` for a finished engagement month: the gap, drawn. */
  gapRange: [number, number] | null;
};


/**
 * One contracted metric on the calendar: the baseline before Zeeraa, the
 * start, and the contracted curve with the months measured against it.
 *
 * Measured and contracted are told apart by three things, not by colour: the
 * actual is a solid line with filled dots, the target is dashed with hollow
 * dots, and each is named on the chart. A month in progress is a hollow dot on
 * a dotted link, never joined to the solid line — it is three weeks of a
 * monthly figure. A month that happened with no figure is a hatched band with
 * its reason in the tooltip and under the chart, so a gap in the line reads as
 * "not measured" rather than as a quiet month.
 *
 * The gap to target is a bar from the actual to the target on each finished
 * engagement month, green where the metric's direction calls it ahead and red
 * where it is behind; the signed figure is under the chart, with its arrow.
 */
export function RampTimelineChart({
  id,
  points,
  format: spec,
  channel,
  caption,
  height = 232,
}: {
  id: string;
  points: RampTimelineChartPoint[];
  format: FormatSpec;
  /**
   * The channel the target and the actual are both scoped to, named on the
   * target line and in the key so a single-channel curve is not read as the
   * account.
   */
  channel: string;
  /** What the chart is, for the table behind it. */
  caption: string;
  height?: number;
}) {
  const animate = useFirstLoad(id);
  const format = formatter(spec);
  const axis = axisFormatter(spec);
  // One per chart: six ramps share a page, and an SVG id is document-wide.
  const hatch = `${id}-not-measured`;

  const rows: Row[] = points.map((p, i) => {
    const previous = points[i - 1];
    const linksBack = p.status === 'partial' && previous?.status === 'complete';
    const linksForward =
      p.status === 'complete' && points[i + 1]?.status === 'partial';
    return {
      ...p,
      partialLink: linksBack ? p.partial : linksForward ? p.actual : null,
      gapRange:
        p.gap && p.actual !== null && p.target !== null ? [p.actual, p.target] : null,
    };
  });

  const baseline = rows.filter((r) => r.phase === 'baseline');
  const engagement = rows.filter((r) => r.phase === 'engagement');
  const start = engagement[0];
  const lastTargetIndex = rows.reduce((last, r, i) => (r.target !== null ? i : last), -1);
  const anyPartial = rows.some((r) => r.status === 'partial');
  const anyUnmeasured = rows.some((r) => r.status === 'not_measured');

  return (
    <div className="crossfade">
      <TimelineLegend channel={channel} hatch={hatch} partial={anyPartial} unmeasured={anyUnmeasured} />

      <div className="mt-3" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 36, right: 12, bottom: 0, left: 0 }}>
            <defs>
              <pattern
                id={hatch}
                width="6"
                height="6"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <line x1="0" y1="0" x2="0" y2="6" stroke={WARN} strokeWidth="1.5" strokeOpacity="0.45" />
              </pattern>
            </defs>

            <CartesianGrid stroke={BORDER} vertical={false} />
            {/* Direct children, never grouped in a fragment: the library finds
                its axes by scanning direct children. The Bar makes this a band
                scale, so a month is a band a hatched area can fill and the
                start can sit on its edge. */}
            <XAxis
              dataKey="key"
              tickFormatter={(key: string) => labelFor(rows, key)}
              {...AXIS}
              interval="preserveStartEnd"
              minTickGap={2}
              dy={4}
            />
            <YAxis {...AXIS} width={56} tickFormatter={(v: number) => axis(v)} />

            {rows
              .filter((r) => r.status === 'not_measured')
              .map((r) => (
                <ReferenceArea
                  key={`nm-${r.key}`}
                  x1={r.key}
                  x2={r.key}
                  fill={`url(#${hatch})`}
                  fillOpacity={1}
                  strokeOpacity={0}
                  ifOverflow="extendDomain"
                />
              ))}

            {baseline.length > 0 && (
              <ReferenceArea
                x1={baseline[0]!.key}
                x2={baseline.at(-1)!.key}
                fillOpacity={0}
                strokeOpacity={0}
                label={{
                  value: 'Baseline · before Zeeraa',
                  position: 'insideTopLeft',
                  fill: TEXT_2,
                  fontSize: 11,
                  dy: -32,
                }}
              />
            )}

            {/* A row below the baseline's label rather than beside it: on a
                phone the baseline is ninety pixels wide and the two collide. */}
            {start && (
              <ReferenceLine
                x={start.key}
                position="start"
                stroke={TEXT_2}
                strokeDasharray="2 3"
                label={{
                  value: 'Engagement starts',
                  position: 'insideTopLeft',
                  fill: TEXT_2,
                  fontSize: 11,
                  dx: 4,
                  dy: -17,
                }}
              />
            )}

            <Tooltip
              cursor={{ fill: BORDER, fillOpacity: 0.35 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0]!.payload as Row;
                return <TooltipCard title={row.title} rows={tooltipRows(row, format, channel)} />;
              }}
            />

            {/* The gap, drawn: actual to target on each finished month. */}
            <Bar dataKey="gapRange" barSize={4} isAnimationActive={animate}>
              {rows.map((r) => (
                <Cell
                  key={`gap-${r.key}`}
                  fill={r.gap?.assessment === 'ahead' ? UP : r.gap?.assessment === 'shortfall' ? DOWN : TEXT_3}
                />
              ))}
            </Bar>

            {/* Dashed, hollow dots: a commitment, not a measurement. */}
            <Line
              type="linear"
              dataKey="target"
              stroke={TEXT_3}
              strokeWidth={2}
              strokeDasharray="6 4"
              dot={{ r: 3, fill: 'var(--color-surface, #fff)', stroke: TEXT_3, strokeWidth: 1.5 }}
              activeDot={{ r: 4 }}
              connectNulls={false}
              isAnimationActive={animate}
            >
              <LabelList
                dataKey="target"
                content={(props) => {
                  const { x, y, index } = props as { x?: number; y?: number; index?: number };
                  if (index !== lastTargetIndex || x == null || y == null) return null;
                  return (
                    // Below and left of the last point: a rising curve ends at
                    // the top of the plot, where the labels above it already are.
                    <text x={Number(x) - 6} y={Number(y) + 16} textAnchor="end" fontSize={11} fill={TEXT_2}>
                      {channel} target
                    </text>
                  );
                }}
              />
            </Line>

            {/* Solid, filled dots: what the API reported. */}
            <Line
              type="linear"
              dataKey="actual"
              stroke={PLOT}
              strokeWidth={2.5}
              dot={{ r: 3.5, fill: PLOT, strokeWidth: 0 }}
              activeDot={{ r: 5 }}
              connectNulls={false}
              isAnimationActive={animate}
            />

            {/* The month in progress: dotted, hollow, never part of the line. */}
            <Line
              type="linear"
              dataKey="partialLink"
              stroke={PLOT}
              strokeWidth={1.5}
              strokeDasharray="1 4"
              dot={false}
              activeDot={false}
              connectNulls={false}
              isAnimationActive={animate}
            />
            <Line
              type="linear"
              dataKey="partial"
              stroke="none"
              dot={{ r: 4, fill: 'var(--color-surface, #fff)', stroke: PLOT, strokeWidth: 2, strokeDasharray: '2 2' }}
              activeDot={{ r: 5 }}
              isAnimationActive={animate}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <ChartTable
        caption={`${caption}: baseline, ${channel} target and actual by month`}
        columns={['Month', 'Target', 'Actual', 'Gap']}
        rows={rows.map((r) => [
          r.title,
          r.target === null ? '—' : format(r.target),
          r.status === 'complete'
            ? format(r.actual!)
            : r.status === 'partial'
              ? `${format(r.partial!)} (partial)`
              : r.status === 'not_measured'
                ? `Not measured${r.inProgress ? ' (partial month)' : ''}: ${r.reason ?? ''}`
                : 'not yet',
          r.gap ? signed(r.gap.absolute, format) : '—',
        ])}
      />
    </div>
  );
}

/** The axis tick: `Oct`, and the year only where it turns or starts. */
function labelFor(rows: Row[], key: string): string {
  return rows.find((r) => r.key === key)?.label ?? key;
}

/** `ahead` / `behind` where the metric is judged; `over` / `under` where it is not. */
function gapWord(row: Row): string {
  const gap = row.gap!;
  if (!row.assessed) return gap.absolute > 0 ? 'over' : gap.absolute < 0 ? 'under' : 'on target';
  return gap.assessment === 'ahead' ? 'ahead' : gap.assessment === 'shortfall' ? 'behind' : 'on target';
}

function signed(value: number, format: (v: number) => string): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${format(Math.abs(value))}`;
}

function tooltipRows(row: Row, format: (v: number) => string, channel: string) {
  const out: { label: string; value: string; color?: string }[] = [];
  if (row.phase === 'engagement') {
    out.push({
      label: `${channel} target`,
      value: row.target === null ? 'none this month' : format(row.target),
      color: TEXT_3,
    });
  }
  const actual =
    row.status === 'complete'
      ? format(row.actual!)
      : row.status === 'partial'
        ? `${format(row.partial!)} · partial, month to date`
        : row.status === 'not_measured'
          ? `Not measured${row.inProgress ? ' so far' : ''} — ${row.reason ?? 'no figure for this month'}`
          : 'not yet';
  out.push({ label: 'actual', value: actual, color: PLOT });
  if (row.gap) {
    out.push({
      label: 'gap',
      value: `${signed(row.gap.absolute, format)} · ${gapWord(row)}`,
      color: row.gap.assessment === 'ahead' ? UP : row.gap.assessment === 'shortfall' ? DOWN : TEXT_3,
    });
  }
  return out;
}

/**
 * The key, by line style and marker as well as by colour: solid with a filled
 * dot, dashed with a hollow one, dotted with a hollow one, and a hatch.
 */
function TimelineLegend({
  channel,
  hatch,
  partial,
  unmeasured,
}: {
  channel: string;
  hatch: string;
  partial: boolean;
  unmeasured: boolean;
}) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-text-2">
      <li className="flex items-center gap-1.5">
        <svg width="22" height="8" aria-hidden="true">
          <line x1="1" y1="4" x2="21" y2="4" stroke={PLOT} strokeWidth="2.5" />
          <circle cx="11" cy="4" r="3" fill={PLOT} />
        </svg>
        Actual · {channel}
      </li>
      <li className="flex items-center gap-1.5">
        <svg width="22" height="8" aria-hidden="true">
          <line x1="1" y1="4" x2="21" y2="4" stroke={TEXT_3} strokeWidth="2" strokeDasharray="5 3" />
          <circle cx="11" cy="4" r="2.6" fill="#fff" stroke={TEXT_3} strokeWidth="1.5" />
        </svg>
        Target · {channel}, engagement model
      </li>
      {partial && (
        <li className="flex items-center gap-1.5">
          <svg width="22" height="8" aria-hidden="true">
            <line x1="1" y1="4" x2="21" y2="4" stroke={PLOT} strokeWidth="1.5" strokeDasharray="1 3" />
            <circle cx="11" cy="4" r="3" fill="#fff" stroke={PLOT} strokeWidth="1.5" strokeDasharray="2 1.5" />
          </svg>
          Partial month
        </li>
      )}
      {unmeasured && (
        <li className="flex items-center gap-1.5">
          <svg width="12" height="12" aria-hidden="true">
            <rect width="12" height="12" rx="2" fill={`url(#${hatch}-legend)`} stroke={WARN} strokeOpacity="0.5" />
            <defs>
              <pattern
                id={`${hatch}-legend`}
                width="4"
                height="4"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <line x1="0" y1="0" x2="0" y2="4" stroke={WARN} strokeWidth="1.5" strokeOpacity="0.6" />
              </pattern>
            </defs>
          </svg>
          Not measured
        </li>
      )}
    </ul>
  );
}
