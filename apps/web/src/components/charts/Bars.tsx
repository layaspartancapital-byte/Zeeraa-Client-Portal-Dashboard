'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
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
  DOWN_EDGE,
  Legend,
  PLOT,
  PLOT_SOFT,
  TEXT,
  TEXT_2,
  TooltipCard,
  UNATTRIBUTED,
  UP,
  UP_EDGE,
  channelColor,
  useFirstLoad,
} from '@/components/charts/chart-kit';
import { formatter, type FormatSpec } from '@/components/charts/format-spec';

/**
 * The category column of a horizontal bar chart, wide enough for a metric's
 * name and wrapping onto a second line rather than being cut off. At 104px
 * with no wrap, "Paid media spend" lost its first letters at some widths and
 * "Cost per deal · Google Ads" never fitted.
 */
const LABEL_WIDTH = 132;
const LINE_CHARS = 19;

function wrapLabel(label: string): string[] {
  const words = label.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && `${line} ${word}`.length > LINE_CHARS) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function WrappedLabel(props: { x: number; y: number; payload: { value: string } }) {
  const lines = wrapLabel(String(props.payload.value));
  const first = -((lines.length - 1) * 14) / 2;
  return (
    <text x={props.x} y={props.y} textAnchor="end" fontSize={12} fill={AXIS.stroke}>
      {lines.map((line, i) => (
        <tspan key={i} x={props.x - 4} dy={i === 0 ? first + 4 : 14}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

export type StackRow = {
  label: string;
  /** Per channel key. Channels only. */
  byChannel: Record<string, number>;
  /**
   * Deals no channel can claim. Its own key, its own colour, never folded into
   * a channel's segment.
   */
  unattributed?: number;
};

/**
 * Stacked bars for category composition. Rounded tops, 4px.
 *
 * Only the top visible segment of a stack is rounded, which is why the
 * unattributed segment carries the radius when it is present: it always sits on
 * top, above every channel, the same way it sits below every channel in the
 * table.
 */
export function StackedBars({
  id,
  rows,
  channels,
  channelLabels,
  format: spec,
  height = 260,
  layout = 'vertical-bars',
  unattributedLabel = 'Direct & other',
}: {
  id: string;
  rows: StackRow[];
  channels: readonly string[];
  /** Platform key to display name. A map, not a function: this is a client component. */
  channelLabels: Record<string, string>;
  format: FormatSpec;
  height?: number;
  /** `vertical-bars` = bars rise from an x-axis of categories. */
  layout?: 'vertical-bars' | 'horizontal-bars';
  unattributedLabel?: string;
}) {
  const animate = useFirstLoad(id);
  const format = formatter(spec);
  const channelLabel = (key: string) => channelLabels[key] ?? key;
  const hasUnattributed = rows.some((r) => (r.unattributed ?? 0) > 0);
  const data = rows.map((r) => ({
    label: r.label,
    ...Object.fromEntries(channels.map((c) => [c, r.byChannel[c] ?? 0])),
    __unattributed: r.unattributed ?? 0,
  }));
  const horizontal = layout === 'horizontal-bars';

  return (
    <div className="crossfade">
      <Legend
        items={[
          ...channels.map((c) => ({ label: channelLabel(c), color: channelColor(c, channels) })),
          ...(hasUnattributed
            ? [{ label: unattributedLabel, color: UNATTRIBUTED }]
            : []),
        ]}
      />
      <div className="mt-3" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout={horizontal ? 'vertical' : 'horizontal'}
            margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
            barCategoryGap={horizontal ? 12 : '22%'}
          >
            <CartesianGrid stroke={BORDER} vertical={horizontal} horizontal={!horizontal} />
            {/*
              Each axis is its own conditional child, never grouped in a
              fragment: the charting library finds its axes by scanning direct
              children, and a fragment hides them from that scan — which leaves
              a chart with gridlines, no tick labels and, in the horizontal
              layout, no bars at all, because the category scale never exists.
            */}
            {horizontal && (
              <XAxis type="number" {...AXIS} tickFormatter={(v: number) => format(v)} />
            )}
            {horizontal && <YAxis type="category" dataKey="label" {...AXIS} width={LABEL_WIDTH} tick={WrappedLabel} />}
            {!horizontal && <XAxis dataKey="label" {...AXIS} dy={4} />}
            {!horizontal && (
              <YAxis {...AXIS} width={48} tickFormatter={(v: number) => format(v)} />
            )}
            <Tooltip
              cursor={{ fill: 'rgba(16,24,40,0.03)' }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                return (
                  <TooltipCard
                    title={String(label)}
                    rows={payload
                      .filter((p) => Number(p.value) > 0)
                      .map((p) => ({
                        label:
                          p.dataKey === '__unattributed'
                            ? unattributedLabel
                            : channelLabel(String(p.dataKey)),
                        value: format(Number(p.value)),
                        color: String(p.color),
                      }))}
                  />
                );
              }}
            />
            {channels.map((c, i) => (
              <Bar
                key={c}
                dataKey={c}
                stackId="s"
                fill={channelColor(c, channels)}
                isAnimationActive={animate}
                animationDuration={400}
                radius={
                  !hasUnattributed && i === channels.length - 1
                    ? horizontal
                      ? [0, 4, 4, 0]
                      : [4, 4, 0, 0]
                    : undefined
                }
              />
            ))}
            {hasUnattributed && (
              <Bar
                dataKey="__unattributed"
                stackId="s"
                fill={UNATTRIBUTED}
                isAnimationActive={animate}
                animationDuration={400}
                radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <ChartTable
        caption="The same composition as a table."
        columns={['Category', ...channels.map(channelLabel), unattributedLabel]}
        rows={rows.map((r) => [
          r.label,
          ...channels.map((c) => format(r.byChannel[c] ?? 0)),
          format(r.unattributed ?? 0),
        ])}
      />
    </div>
  );
}

export type RangeRow = {
  label: string;
  platform: string;
  /** The confirmed figure: this channel's spend over its attributed deals. */
  confirmed: number;
  /** The most generous reading: every unattributed deal turning out to be this. */
  low: number;
  attributedDeals: number;
  unattributedDeals: number;
};

/**
 * Cost per deal by channel, drawn as the range the data supports.
 *
 * The soft blue bar is the plausible range; the solid marker at its right-hand
 * end is the confirmed value. Two channels with the same figure and different
 * coverage look different here, which a pair of plain bars cannot show — and
 * the length of the bar is the cost of the attribution gap, in the same units
 * as the metric.
 */
export function RangeBars({
  id,
  rows,
  format: spec,
  target,
  height = 260,
}: {
  id: string;
  rows: RangeRow[];
  format: FormatSpec;
  target?: { value: number; label: string } | null;
  height?: number;
}) {
  const animate = useFirstLoad(id);
  const format = formatter(spec);

  if (rows.length === 0) {
    return (
      <p className="text-[13px] text-text-3">
        No channel has a deal attributed to it in this window.
      </p>
    );
  }

  // The solid marker is a short stacked segment at the confirmed end rather
  // than an overlay, so `base + span + marker` lands exactly on `confirmed` and
  // the mark cannot overstate the figure it is marking.
  const widest = Math.max(...rows.map((r) => r.confirmed), 1);
  const marker = widest * 0.012;
  const data = rows.map((r) => ({
    ...r,
    base: r.low,
    span: Math.max(r.confirmed - r.low - marker, 0),
    marker: Math.min(marker, r.confirmed),
  }));

  return (
    <div className="crossfade">
      <Legend
        items={[
          { label: 'Confirmed', color: PLOT },
          { label: 'Range if every unattributed deal were this channel', color: PLOT_SOFT },
        ]}
      />
      <div className="mt-3" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 8, right: 76, bottom: 0, left: 0 }}
            barCategoryGap={16}
          >
            <CartesianGrid stroke={BORDER} horizontal={false} />
            <XAxis type="number" {...AXIS} tickFormatter={(v: number) => format(v)} />
            <YAxis type="category" dataKey="label" {...AXIS} width={LABEL_WIDTH} tick={WrappedLabel} />
            <Tooltip
              cursor={{ fill: 'rgba(16,24,40,0.03)' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0]!.payload as (typeof data)[number];
                return (
                  <TooltipCard
                    title={d.label}
                    rows={[
                      { label: 'Confirmed', value: format(d.confirmed), color: PLOT },
                      { label: 'Over', value: `${d.attributedDeals} attributed deals` },
                      {
                        label: 'Range',
                        value: `${format(d.low)} – ${format(d.confirmed)}`,
                        color: PLOT_SOFT,
                      },
                      { label: 'Direct & other', value: `${d.unattributedDeals} deals` },
                    ]}
                  />
                );
              }}
            />
            {target && (
              <ReferenceLine
                x={target.value}
                stroke={PLOT}
                strokeDasharray="5 4"
                strokeWidth={1.5}
                label={{
                  value: target.label,
                  position: 'top',
                  fill: PLOT,
                  fontSize: 12,
                  fontWeight: 600,
                }}
              />
            )}
            {/* Offset to the low end, so the visible bar is the range itself
                rather than a magnitude measured from zero. */}
            <Bar dataKey="base" stackId="r" fill="transparent" isAnimationActive={false} />
            <Bar
              dataKey="span"
              stackId="r"
              fill={PLOT_SOFT}
              radius={[4, 0, 0, 4]}
              isAnimationActive={animate}
              animationDuration={400}
            />
            {/* The confirmed value, as a solid marker at the range's end. */}
            <Bar
              dataKey="marker"
              stackId="r"
              fill={PLOT}
              radius={[2, 2, 2, 2]}
              isAnimationActive={animate}
              animationDuration={400}
            >
              <LabelList
                dataKey="confirmed"
                position="right"
                offset={12}
                fill={TEXT}
                fontSize={12}
                fontWeight={600}
                formatter={(v: number) => format(v)}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <ChartTable
        caption="Cost per deal by channel, with the range the data supports."
        columns={['Channel', 'Confirmed', 'Low end of range', 'Attributed deals', 'Unattributed deals']}
        rows={rows.map((r) => [
          r.label,
          format(r.confirmed),
          format(r.low),
          r.attributedDeals,
          r.unattributedDeals,
        ])}
      />
    </div>
  );
}

/**
 * Month-over-month change: a diverging bar per channel, each labelled with its
 * signed value.
 *
 * The domain is forced symmetric about zero, because a diverging chart whose
 * scale excludes the baseline draws every bar as though it filled the scale.
 * Colour comes from the metric's improvement direction, and the sign and the
 * side of the baseline carry it as well.
 */
export function DivergingBars({
  id,
  rows,
  format: spec,
  height = 260,
}: {
  id: string;
  rows: { label: string; value: number; assessment: 'ahead' | 'shortfall' | 'level' }[];
  format: FormatSpec;
  height?: number;
}) {
  const animate = useFirstLoad(id);
  const format = formatter(spec);

  if (rows.length === 0) {
    return <p className="text-[13px] text-text-3">No channel has two comparable periods yet.</p>;
  }

  const largest = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  const bound = largest * 1.25;
  const signed = (v: number) => (v === 0 ? format(0) : `${v < 0 ? '−' : '+'}${format(Math.abs(v))}`);

  return (
    <div className="crossfade">
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            layout="vertical"
            margin={{ top: 8, right: 84, bottom: 0, left: 0 }}
            barCategoryGap={16}
          >
            <CartesianGrid stroke={BORDER} horizontal={false} />
            <XAxis
              type="number"
              {...AXIS}
              domain={[-bound, bound]}
              ticks={[-bound, -bound / 2, 0, bound / 2, bound]}
              tickFormatter={(v: number) => signed(v)}
            />
            <YAxis type="category" dataKey="label" {...AXIS} width={LABEL_WIDTH} tick={WrappedLabel} />
            <ReferenceLine x={0} stroke={TEXT_2} strokeWidth={1} />
            <Tooltip
              cursor={{ fill: 'rgba(16,24,40,0.03)' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0]!.payload as (typeof rows)[number];
                return (
                  <TooltipCard
                    title={r.label}
                    rows={[{ label: 'Change', value: signed(r.value) }]}
                  />
                );
              }}
            />
            <Bar
              dataKey="value"
              isAnimationActive={animate}
              animationDuration={400}
              radius={[0, 4, 4, 0]}
            >
              {rows.map((r) => (
                <Cell
                  key={r.label}
                  fill={
                    r.assessment === 'ahead' ? UP : r.assessment === 'shortfall' ? DOWN : PLOT
                  }
                  stroke={
                    r.assessment === 'ahead'
                      ? UP_EDGE
                      : r.assessment === 'shortfall'
                        ? DOWN_EDGE
                        : PLOT
                  }
                  strokeWidth={1}
                />
              ))}
              <LabelList
                dataKey="value"
                position="right"
                offset={10}
                fill={TEXT}
                fontSize={12}
                fontWeight={600}
                formatter={(v: number) => signed(v)}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <ChartTable
        caption="Change against the previous period, per channel."
        columns={['Channel', 'Change', 'Assessment']}
        rows={rows.map((r) => [r.label, signed(r.value), r.assessment])}
      />
    </div>
  );
}
