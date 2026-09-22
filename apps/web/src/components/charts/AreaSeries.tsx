'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
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
  PLOT,
  TooltipCard,
  useFirstLoad,
} from '@/components/charts/chart-kit';
import { formatter, type FormatSpec } from '@/components/charts/format-spec';

export type SeriesPoint = {
  label: string;
  /** Null where the period was never ingested. Plotted as a gap, never as 0. */
  value: number | null;
  /** Still settling: platforms restate conversions for 30+ days. */
  provisional?: boolean;
};

/**
 * The time-series area chart: 2px stroke, gradient fill from the primary at 18%
 * to nothing, thin horizontal gridlines, no vertical ones.
 *
 * The provisional tail is a separate dashed series sharing its first point with
 * the settled one, so the line is continuous while the recent segment is
 * visibly unsettled. The card header carries the badge.
 *
 * A target is drawn only where one is reconciled — the caller decides that and
 * passes null otherwise. A dashed line across a chart reads as a commitment
 * somebody made, and drawing one the paperwork contradicts is worse than
 * drawing none.
 */
export function AreaSeries({
  id,
  points,
  format: spec,
  target,
  height = 260,
  yWidth = 64,
}: {
  id: string;
  points: SeriesPoint[];
  format: FormatSpec;
  target?: { value: number; label: string } | null;
  height?: number;
  yWidth?: number;
}) {
  const animate = useFirstLoad(id);
  const format = formatter(spec);
  const firstProvisional = points.findIndex((p) => p.provisional && p.value !== null);

  /**
   * The two series share the last settled point.
   *
   * A dashed series that started at the first provisional bucket would be a
   * single point with nothing to draw a segment to, so the tail would render
   * solid. Overlapping by one point puts the dash on the segment that is
   * actually unsettled.
   */
  const handover = firstProvisional < 0 ? -1 : Math.max(0, firstProvisional - 1);
  const data = points.map((p, i) => ({
    label: p.label,
    settled: p.value !== null && (handover < 0 || i <= handover) ? p.value : null,
    provisional: p.value !== null && handover >= 0 && i >= handover ? p.value : null,
  }));

  const measured = points.filter((p) => p.value !== null);
  if (measured.length === 0) {
    return (
      <p className="px-5 pb-5 text-[13px] text-text-3">
        No period in this window has been ingested yet.
      </p>
    );
  }

  return (
    <div className="crossfade">
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={PLOT} stopOpacity={0.18} />
                <stop offset="100%" stopColor={PLOT} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={BORDER} vertical={false} />
            <XAxis dataKey="label" {...AXIS} dy={4} interval="preserveStartEnd" />
            <YAxis {...AXIS} width={yWidth} tickFormatter={(v: number) => format(v)} />
            <Tooltip
              cursor={{ stroke: BORDER }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const point = payload.find((p) => p.value !== null);
                if (!point) return null;
                return (
                  <TooltipCard
                    title={String(label)}
                    rows={[
                      {
                        label: point.dataKey === 'provisional' ? 'Provisional' : 'Value',
                        value: format(Number(point.value)),
                        color: PLOT,
                      },
                    ]}
                  />
                );
              }}
            />
            {target && (
              <ReferenceLine
                y={target.value}
                stroke={PLOT}
                strokeDasharray="5 4"
                strokeWidth={1.5}
                label={{
                  value: target.label,
                  position: 'insideTopRight',
                  fill: PLOT,
                  fontSize: 12,
                  fontWeight: 600,
                }}
              />
            )}
            <Area
              type="monotone"
              dataKey="settled"
              stroke={PLOT}
              strokeWidth={2}
              fill={`url(#${id}-fill)`}
              connectNulls={false}
              dot={false}
              activeDot={{ r: 4, fill: PLOT, stroke: '#fff', strokeWidth: 2 }}
              isAnimationActive={animate}
              animationDuration={400}
            />
            <Area
              type="monotone"
              dataKey="provisional"
              stroke={PLOT}
              strokeWidth={2}
              strokeDasharray="5 4"
              fill={`url(#${id}-fill)`}
              connectNulls={false}
              dot={false}
              activeDot={{ r: 4, fill: PLOT, stroke: '#fff', strokeWidth: 2 }}
              isAnimationActive={animate}
              animationDuration={400}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <ChartTable
        caption="The same series as a table."
        columns={['Period', 'Value', 'Status']}
        rows={points.map((p) => [
          p.label,
          p.value === null ? 'not ingested' : format(p.value),
          p.value === null ? 'no measurement' : p.provisional ? 'provisional' : 'settled',
        ])}
      />
    </div>
  );
}
