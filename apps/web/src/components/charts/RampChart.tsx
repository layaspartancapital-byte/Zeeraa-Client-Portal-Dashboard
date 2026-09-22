'use client';

import {
  CartesianGrid,
  Line,
  LineChart,
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
  Legend,
  PLOT,
  TEXT_3,
  TooltipCard,
  UP,
  useFirstLoad,
} from '@/components/charts/chart-kit';
import { formatter, type FormatSpec } from '@/components/charts/format-spec';

export type RampChartPoint = {
  /** `M3`. */
  label: string;
  /** The contracted figure for this ramp month, or null where none is. */
  target: number | null;
  /** What happened in the calendar month it lands on, or null. */
  actual: number | null;
  /** `Dec 2026`, or null until a start month is recorded. */
  month: string | null;
  /** Signed distance from target, and whether it is an improvement. */
  gap: { absolute: number; assessment: 'ahead' | 'shortfall' | 'level' } | null;
};

/**
 * One contracted metric against its curve, on a ramp-month axis.
 *
 * **The axis is M1–M8, not a calendar.** The contract says what month three of
 * the engagement costs; it does not say when month three is. Drawing the
 * commitment on a calendar axis means it cannot be drawn at all until somebody
 * records the start month — which is how this chart previously rendered empty
 * against a curve that had been fully specified since the contract was signed.
 * On an M axis the commitment is always drawable, and the actual is the half
 * that waits.
 *
 * Target is dashed, actual is solid, and the actual is coloured by the metric's
 * own improvement direction through `tone` — a falling cost per funded deal is
 * green while it points down. The caller derives `tone` from
 * `improvementDirectionFor`, never from the direction of travel.
 */
export function RampChart({
  id,
  points,
  format: spec,
  tone = 'primary',
  height = 200,
  targetLabel = 'contracted',
  actualLabel = 'actual',
}: {
  id: string;
  points: RampChartPoint[];
  format: FormatSpec;
  /** How the measured line is drawn, from the metric's direction. */
  tone?: 'primary' | 'ahead' | 'shortfall';
  height?: number;
  targetLabel?: string;
  actualLabel?: string;
}) {
  const animate = useFirstLoad(id);
  const format = formatter(spec);
  const stroke = tone === 'ahead' ? UP : tone === 'shortfall' ? DOWN : PLOT;
  const anyActual = points.some((p) => p.actual !== null);

  return (
    <div className="crossfade">
      <Legend
        items={[
          { label: targetLabel, color: TEXT_3, dashed: true },
          ...(anyActual ? [{ label: actualLabel, color: stroke }] : []),
        ]}
      />

      <div className="mt-3" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={BORDER} vertical={false} />
            {/* Direct children, never grouped in a fragment: the library finds
                its axes by scanning direct children, and a fragment leaves the
                chart with gridlines and no tick labels. */}
            <XAxis dataKey="label" {...AXIS} dy={4} />
            <YAxis {...AXIS} width={56} tickFormatter={(v: number) => format(v)} />

            <Tooltip
              cursor={{ stroke: BORDER }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const point = payload[0]!.payload as RampChartPoint;
                const rows: { label: string; value: string; color?: string }[] = [
                  {
                    label: targetLabel,
                    value: point.target === null ? 'none this month' : format(point.target),
                    color: TEXT_3,
                  },
                ];
                rows.push({
                  label: actualLabel,
                  value:
                    point.actual === null
                      ? point.month === null
                        ? 'no start month recorded'
                        : 'not measured'
                      : format(point.actual),
                  color: stroke,
                });
                // The gap in the metric's own unit, which is what the number on
                // the card is argued about in. A chart shows one line above
                // another; it does not say by how much.
                if (point.gap) {
                  rows.push({
                    label: 'gap',
                    value: `${point.gap.absolute > 0 ? '+' : point.gap.absolute < 0 ? '−' : ''}${format(
                      Math.abs(point.gap.absolute),
                    )}`,
                    color: point.gap.assessment === 'level' ? TEXT_3 : stroke,
                  });
                }
                return (
                  <TooltipCard
                    title={point.month ? `${point.label} · ${point.month}` : point.label}
                    rows={rows}
                  />
                );
              }}
            />

            {/* Dashed and grey: a commitment is not a measurement, and it must
                not read as one when the solid line beside it is absent. */}
            <Line
              type="monotone"
              dataKey="target"
              stroke={TEXT_3}
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={{ r: 2.5, fill: TEXT_3, strokeWidth: 0 }}
              activeDot={{ r: 4 }}
              connectNulls={false}
              isAnimationActive={animate}
            />
            <Line
              type="monotone"
              dataKey="actual"
              stroke={stroke}
              strokeWidth={2.5}
              dot={{ r: 3, fill: stroke, strokeWidth: 0 }}
              activeDot={{ r: 5 }}
              connectNulls={false}
              isAnimationActive={animate}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <ChartTable
        caption={`${targetLabel} and ${actualLabel} by engagement month`}
        columns={['Month', targetLabel, actualLabel]}
        rows={points.map((p) => [
          p.month ? `${p.label} (${p.month})` : p.label,
          p.target === null ? 'none' : format(p.target),
          p.actual === null ? 'not measured' : format(p.actual),
        ])}
      />
    </div>
  );
}
