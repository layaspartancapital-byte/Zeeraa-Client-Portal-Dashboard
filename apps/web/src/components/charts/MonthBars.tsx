'use client';

import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCount } from '@zeeraa/core';
import { BORDER, ChartTable, PLOT, TEXT_2, TEXT_3, TooltipCard, useFirstLoad } from '@/components/charts/chart-kit';

export type MonthBar = {
  /** `2026-06`. */
  key: string;
  /** `Jun`. */
  label: string;
  /** `June 2026`, for the tooltip. */
  title: string;
  value: number;
  /** Why this month is not whole — `from Jun 18`, `month so far` — or null. */
  partial: string | null;
};

/**
 * A count per month a client can read without a key: the month under each
 * bar, the count on it, and a partial month drawn lighter with "partial"
 * under its label and the reason on hover.
 *
 * For a monthly volume — calls, declines. A partial month is still drawn,
 * because what happened in it happened; it is marked so a short bar is not
 * read as a bad month.
 */
export function MonthBars({
  id,
  bars,
  noun,
  height = 200,
}: {
  id: string;
  bars: MonthBar[];
  /** `['call', 'calls']`. */
  noun: readonly [string, string];
  height?: number;
}) {
  const animate = useFirstLoad(id);
  const word = (n: number) => (n === 1 ? noun[0] : noun[1]);

  return (
    <div className="crossfade">
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={bars} margin={{ top: 22, right: 4, bottom: 0, left: 4 }} barCategoryGap="22%">
            <CartesianGrid stroke={BORDER} vertical={false} />
            {/* Direct children: the library finds axes by scanning them. */}
            <XAxis
              dataKey="key"
              interval={0}
              tickLine={false}
              axisLine={false}
              height={34}
              tick={(props: { x: number; y: number; payload: { value: string } }) => {
                const bar = bars.find((b) => b.key === props.payload.value);
                return (
                  <g transform={`translate(${props.x},${props.y})`}>
                    <text dy={13} textAnchor="middle" fontSize={11} fill={TEXT_2}>
                      {bar?.label}
                    </text>
                    {bar?.partial && (
                      <text dy={26} textAnchor="middle" fontSize={10} fill={TEXT_3}>
                        partial
                      </text>
                    )}
                  </g>
                );
              }}
            />
            <YAxis hide domain={[0, 'dataMax']} />
            <Tooltip
              cursor={{ fill: BORDER, fillOpacity: 0.35 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const bar = payload[0]!.payload as MonthBar;
                return (
                  <TooltipCard
                    title={bar.title}
                    rows={[
                      { label: word(bar.value), value: formatCount(bar.value), color: PLOT },
                      ...(bar.partial ? [{ label: 'partial month', value: bar.partial }] : []),
                    ]}
                  />
                );
              }}
            />
            <Bar dataKey="value" radius={[4, 4, 0, 0]} isAnimationActive={animate}>
              {bars.map((b) => (
                <Cell
                  key={b.key}
                  fill={PLOT}
                  fillOpacity={b.partial ? 0.35 : 1}
                  stroke={b.partial ? PLOT : 'none'}
                  strokeDasharray={b.partial ? '3 2' : undefined}
                />
              ))}
              <LabelList
                dataKey="value"
                position="top"
                fontSize={11}
                fill={TEXT_2}
                formatter={(v: number) => formatCount(v)}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ChartTable
        caption={`${noun[1]} per month`}
        columns={['Month', noun[1], 'Note']}
        rows={bars.map((b) => [b.title, formatCount(b.value), b.partial ? `partial month, ${b.partial}` : ''])}
      />
    </div>
  );
}
