'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AXIS, BORDER, ChartTable, Legend, SERIES, TooltipCard, useFirstLoad } from '@/components/charts/chart-kit';
import { axisFormatter, formatter, type FormatSpec } from '@/components/charts/format-spec';

/** Period A in the lead slot, Period B in a lighter one far from it in every vision. */
export const PERIOD_A = SERIES[0];
export const PERIOD_B = SERIES[4];

export type PairedRow = {
  label: string;
  /** Null where the period has no figure: no bar, never a zero. */
  a: number | null;
  b: number | null;
};

/**
 * Two periods side by side per category (the Comparison page, 30 October
 * 2026): Period A in ink, Period B lighter, each named in the legend so the
 * colour is never the only encoding. A missing figure draws no bar and reads
 * "—" in the table beneath.
 */
export function PairedBars({
  id,
  rows,
  names,
  format: spec,
  height = 260,
  layout = 'vertical-bars',
}: {
  id: string;
  rows: PairedRow[];
  /** "Period A · Oct 1 – Oct 30, 2026", for the legend and the tooltip. */
  names: { a: string; b: string };
  format: FormatSpec;
  height?: number;
  /** `horizontal-bars` for long category names (sources). */
  layout?: 'vertical-bars' | 'horizontal-bars';
}) {
  const animate = useFirstLoad(id);
  const format = formatter(spec);
  const tick = axisFormatter(spec);
  const horizontal = layout === 'horizontal-bars';
  const data = rows.map((r) => ({ label: r.label, a: r.a, b: r.b }));

  return (
    <div className="crossfade min-w-0">
      <Legend
        items={[
          { label: names.a, color: PERIOD_A },
          { label: names.b, color: PERIOD_B },
        ]}
      />
      <div className="mt-3" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout={horizontal ? 'vertical' : 'horizontal'}
            margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
            barCategoryGap={horizontal ? 10 : '20%'}
            barGap={2}
          >
            <CartesianGrid stroke={BORDER} vertical={horizontal} horizontal={!horizontal} />
            {/* Each axis a direct child: a fragment hides it from the library's scan. */}
            {horizontal && <XAxis type="number" {...AXIS} allowDecimals={spec.kind !== 'count'} tickFormatter={(v: number) => tick(v)} />}
            {horizontal && <YAxis type="category" dataKey="label" {...AXIS} width={132} />}
            {!horizontal && <XAxis dataKey="label" {...AXIS} dy={4} interval={0} />}
            {!horizontal && <YAxis {...AXIS} width={56} allowDecimals={spec.kind !== 'count'} tickFormatter={(v: number) => tick(v)} />}
            <Tooltip
              cursor={{ fill: 'rgba(16,24,40,0.03)' }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                return (
                  <TooltipCard
                    title={String(label)}
                    rows={payload.map((p) => ({
                      label: p.dataKey === 'a' ? names.a : names.b,
                      value: p.value == null ? '—' : format(Number(p.value)),
                      color: String(p.color),
                    }))}
                  />
                );
              }}
            />
            <Bar
              dataKey="a"
              fill={PERIOD_A}
              isAnimationActive={animate}
              animationDuration={400}
              radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
            />
            <Bar
              dataKey="b"
              fill={PERIOD_B}
              isAnimationActive={animate}
              animationDuration={400}
              radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <ChartTable
        caption="The same figures as a table."
        columns={['Category', names.a, names.b]}
        rows={rows.map((r) => [r.label, r.a === null ? '—' : format(r.a), r.b === null ? '—' : format(r.b)])}
      />
    </div>
  );
}
