'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ErrorBar,
  LabelList,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  delta,
  formatCount,
  formatCurrency,
  formatDelta,
  type ChannelCostPerDeal,
  type ImprovementDirection,
} from '@zeeraa/core';
import type { MonthPoint, MonthlyPerformance } from '@/lib/reporting';

/**
 * Charts for the performance screen.
 *
 * Three rules govern all of them, and two come from this project rather than
 * from charting practice.
 *
 * **No dual axis.** The brief asks for spend and funded deals "over time, dual
 * series". Spend is tens of thousands and deals are tens, so one plot with two
 * y-scales would let any visual relationship between the lines be manufactured
 * by the scaling. They are two stacked plots sharing an x-axis instead, which
 * answers the same question and cannot be tuned into a story.
 *
 * **A cost-per-deal figure carries its range.** The by-channel chart draws the
 * interval, not a bar to the point estimate. A bar says "this is the number";
 * the interval says what the data actually supports, which for a channel with
 * twelve unattributed deals beside it is a different claim.
 *
 * **Direction never comes from colour alone.** Every change carries its sign,
 * and the bar's side of the baseline carries it again. Colour is third, and it
 * is derived from the metric's `improvement_direction` — a falling cost per
 * funded deal is good, so down is green here and up is green elsewhere.
 */

// Categorical slots for channels, validated against the light surface
// (worst adjacent CVD ΔE 9.2, normal-vision ΔE 27.6). Assigned in fixed order
// by channel identity, never by rank, so a filter that drops a channel never
// repaints the others.
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'] as const;

// Unattributed is deliberately not a categorical slot. It is not a channel, and
// giving it a hue alongside the channels would undo in the chart exactly what
// the table's separate row establishes.
const UNATTRIBUTED = '#b8b5ae';
const INK = '#14161a';
const GRAPHITE = '#5a6169';
const RULE = '#e4e3df';
const BRASS = '#8a6b1f';

const AXIS = { stroke: GRAPHITE, fontSize: 11, tickLine: false, axisLine: { stroke: RULE } };

function channelColor(platform: string, order: string[]): string {
  const i = order.indexOf(platform);
  return SERIES[i % SERIES.length]!;
}

function TooltipBox({ rows, title }: { rows: [string, string][]; title: string }) {
  return (
    <div className="border border-rule bg-surface px-3 py-2 text-[11px] shadow-none">
      <p className="text-ink">{title}</p>
      {rows.map(([k, v]) => (
        <p key={k} className="mt-0.5 text-graphite tabular-nums">
          {k} <span className="text-ink">{v}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * Spend over time and funded deals over time, stacked, sharing an x-axis.
 */
export function SpendAndDealsOverTime({
  series,
  channels,
  currency,
  valueLabel,
}: {
  series: MonthPoint[];
  channels: string[];
  currency: string;
  valueLabel: string;
}) {
  // null, not 0, for a month before anything was ingested. A line that drops to
  // the axis says the spend stopped; these months are ones nobody looked at.
  const spendData = series.map((p) => ({
    label: p.label,
    ...Object.fromEntries(
      channels.map((c) => [c, p.ingested ? (p.byPlatform[c]?.spend ?? 0) : null]),
    ),
  }));
  const dealData = series.map((p) => ({
    label: p.label,
    ...Object.fromEntries(
      channels.map((c) => [c, p.ingested ? (p.byPlatform[c]?.deals ?? 0) : null]),
    ),
    unattributed: p.ingested ? p.unattributedDeals : null,
  }));
  const gap = series.some((p) => !p.ingested);

  return (
    <div className="px-5 py-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
        {channels.map((c) => (
          <span key={c} className="flex items-center gap-1.5 text-graphite">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-[1px]"
              style={{ background: channelColor(c, channels) }}
            />
            {c.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())}
          </span>
        ))}
        <span className="flex items-center gap-1.5 text-graphite">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-[1px]"
            style={{ background: UNATTRIBUTED }}
          />
          unattributed (deals only — no spend stands behind these)
        </span>
      </div>

      <p className="mt-4 text-[11px] text-graphite">Spend per month</p>
      <div className="mt-1 h-[150px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={spendData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={RULE} vertical={false} />
            <XAxis dataKey="label" {...AXIS} />
            <YAxis
              {...AXIS}
              width={64}
              tickFormatter={(v: number) => formatCurrency(v, currency)}
            />
            <Tooltip
              cursor={{ stroke: RULE }}
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <TooltipBox
                    title={String(label)}
                    rows={payload.map((p) => [
                      String(p.name).replace(/_/g, ' '),
                      formatCurrency(Number(p.value), currency),
                    ])}
                  />
                ) : null
              }
            />
            {channels.map((c) => (
              <Line
                key={c}
                type="monotone"
                dataKey={c}
                stroke={channelColor(c, channels)}
                strokeWidth={2}
                connectNulls={false}
                dot={{ r: 3, strokeWidth: 0, fill: channelColor(c, channels) }}
                activeDot={{ r: 5, stroke: '#fff', strokeWidth: 2 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {gap && (
        <p className="mt-3 text-[11px] text-graphite">
          Months before ingestion began are blank rather than zero. Nobody looked; the spend was
          not measured to be nothing.
        </p>
      )}

      <p className="mt-5 text-[11px] text-graphite">{valueLabel} deals per month</p>
      <div className="mt-1 h-[150px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={dealData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={RULE} vertical={false} />
            <XAxis dataKey="label" {...AXIS} />
            <YAxis {...AXIS} width={64} allowDecimals={false} />
            <Tooltip
              cursor={{ stroke: RULE }}
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <TooltipBox
                    title={String(label)}
                    rows={payload.map((p) => [
                      String(p.name).replace(/_/g, ' '),
                      formatCount(Number(p.value)),
                    ])}
                  />
                ) : null
              }
            />
            {channels.map((c) => (
              <Line
                key={c}
                type="monotone"
                dataKey={c}
                stroke={channelColor(c, channels)}
                strokeWidth={2}
                connectNulls={false}
                dot={{ r: 3, strokeWidth: 0, fill: channelColor(c, channels) }}
                activeDot={{ r: 5, stroke: '#fff', strokeWidth: 2 }}
              />
            ))}
            {/* Its own line, never folded into a channel's. */}
            <Line
              type="monotone"
              dataKey="unattributed"
              stroke={UNATTRIBUTED}
              strokeWidth={2}
              strokeDasharray="4 3"
              connectNulls={false}
              dot={{ r: 3, strokeWidth: 0, fill: UNATTRIBUTED }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/**
 * Cost per funded deal by channel, drawn as the interval the data supports.
 *
 * The marker is the confirmed figure — spend over deals attributed to that
 * channel. The bar behind it runs to the figure the channel would show if every
 * unattributed deal in the period turned out to be its. A reader comparing two
 * channels sees not only which is cheaper but which claim is better supported,
 * which a pair of bars cannot show.
 */
export function CostPerDealByChannel({
  rows,
  currency,
  target,
}: {
  rows: { label: string; platform: string; cost: ChannelCostPerDeal }[];
  currency: string;
  target: number | null;
}) {
  const order = rows.map((r) => r.platform);
  const data = rows
    .filter((r) => r.cost.value !== null)
    .map((r) => {
      const low = r.cost.plausibleRange.low ?? r.cost.value!;
      const high = r.cost.value!;
      return {
        label: r.label,
        platform: r.platform,
        low,
        high,
        mid: (low + high) / 2,
        span: (high - low) / 2,
        zero: 0,
        attributed: r.cost.attributedDeals,
        unattributed: r.cost.unattributedDeals,
      };
    });

  if (data.length === 0) {
    return (
      <p className="px-5 py-8 text-[12px] text-graphite">
        No channel has a deal attributed to it in this period, so there is no cost per deal to
        draw.
      </p>
    );
  }

  return (
    <div className="px-5 py-5">
      <div className="h-[180px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 4, right: 24, bottom: 0, left: 8 }}
            barCategoryGap={18}
          >
            <CartesianGrid stroke={RULE} horizontal={false} />
            <XAxis
              type="number"
              {...AXIS}
              tickFormatter={(v: number) => formatCurrency(v, currency)}
            />
            <YAxis type="category" dataKey="label" {...AXIS} width={96} />
            <Tooltip
              cursor={{ fill: 'rgba(0,0,0,0.03)' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0]!.payload as (typeof data)[number];
                return (
                  <TooltipBox
                    title={d.label}
                    rows={[
                      ['confirmed', formatCurrency(d.high, currency)],
                      ['over', `${formatCount(d.attributed)} attributed deals`],
                      [
                        'range',
                        `${formatCurrency(d.low, currency)} – ${formatCurrency(d.high, currency)}`,
                      ],
                      ['if all', `${formatCount(d.unattributed)} unattributed were this channel`],
                    ]}
                  />
                );
              }}
            />
            {target !== null && (
              <ReferenceLine
                x={target}
                stroke={BRASS}
                strokeWidth={2}
                label={{
                  value: `Target ${formatCurrency(target, currency)}`,
                  position: 'top',
                  fill: BRASS,
                  fontSize: 11,
                }}
              />
            )}
            {/* The interval. `mid` positions it; the error bar draws the span,
                so the mark is the range rather than a magnitude from zero. */}
            {/* The interval. */}
            <Bar dataKey="mid" fill="transparent" isAnimationActive={false}>
              <ErrorBar dataKey="span" width={10} strokeWidth={2} stroke={GRAPHITE} direction="x" />
            </Bar>
            {/* The confirmed figure, marked and labelled. Without this the two
                ends of the interval look interchangeable, and they are not: one
                is what the data shows and the other is a hypothetical. */}
            <Bar dataKey="high" fill="transparent" isAnimationActive={false} legendType="none">
              {data.map((d) => (
                <Cell key={d.platform} />
              ))}
              <LabelList
                dataKey="high"
                position="right"
                offset={10}
                fill={INK}
                fontSize={11}
                formatter={(v: number) => formatCurrency(v, currency)}
              />
              <ErrorBar dataKey="zero" width={12} strokeWidth={3} stroke={INK} direction="x" />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-graphite">
        Each bar is the range the data supports, not a single figure. The right-hand end is the
        confirmed cost per deal — this channel&rsquo;s spend over the deals attributed to it. The
        left-hand end is where it would land if every unattributed deal in the period turned out to
        be this channel&rsquo;s. A short bar is a well-covered figure; a long one is a channel whose
        cost per deal is not yet pinned down.
      </p>
    </div>
  );
}

/** Funnel-stage composition by channel. Unattributed is its own segment. */
export function StageComposition({ data }: { data: MonthlyPerformance }) {
  const channels = data.channels.map((c) => c.platform);
  const measurable = data.stages.filter((s) => !data.stageStatus[s.key]?.blocked);

  const rows = measurable.map((stage) => ({
    label: stage.label,
    ...Object.fromEntries(
      data.channels.map((c) => [c.platform, c.stages[stage.key] ?? 0]),
    ),
    unattributed: data.unattributed.stages[stage.key] ?? 0,
  }));

  return (
    <div className="px-5 py-5">
      <div className="h-[200px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
            <CartesianGrid stroke={RULE} horizontal={false} />
            <XAxis type="number" {...AXIS} />
            <YAxis type="category" dataKey="label" {...AXIS} width={96} />
            <Tooltip
              cursor={{ fill: 'rgba(0,0,0,0.03)' }}
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <TooltipBox
                    title={String(label)}
                    rows={payload.map((p) => [
                      String(p.name).replace(/_/g, ' '),
                      formatCount(Number(p.value)),
                    ])}
                  />
                ) : null
              }
            />
            {channels.map((c) => (
              // 2px surface gap between stacked segments.
              <Bar
                key={c}
                dataKey={c}
                stackId="s"
                fill={channelColor(c, channels)}
                stroke="#fff"
                strokeWidth={2}
              />
            ))}
            <Bar
              dataKey="unattributed"
              stackId="s"
              fill={UNATTRIBUTED}
              stroke="#fff"
              strokeWidth={2}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-[11px] text-graphite">
        Blocked stages are absent rather than drawn at zero. Unattributed is a segment, not a
        channel.
      </p>
    </div>
  );
}

/**
 * Month over month, with the sign on every bar.
 *
 * Direction comes from the metric's improvement direction, so a falling cost per
 * funded deal reads as ahead while falling funded volume reads as a shortfall.
 * The sign and the side of the baseline both carry it; colour is the third
 * encoding, never the only one.
 */
export function MonthOverMonth({
  series,
  channels,
  currency,
  improvementDirection = 'up',
}: {
  series: MonthPoint[];
  channels: string[];
  currency: string;
  improvementDirection?: ImprovementDirection;
}) {
  const current = series.at(-1);
  const previous = series.at(-2);
  if (!current || !previous) {
    return (
      <p className="px-5 py-8 text-[12px] text-graphite">
        Two complete months are needed before a month-over-month change means anything. There
        {series.length === 1 ? ' is 1 month' : ` are ${series.length} months`} of data.
      </p>
    );
  }

  const rows = channels.map((c) => {
    const now = current.byPlatform[c]?.spend ?? 0;
    const then = previous.byPlatform[c]?.spend ?? 0;
    return {
      platform: c,
      label: c.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
      value: now - then,
      d: delta(now, then, improvementDirection),
    };
  });

  // A diverging chart whose domain excludes zero draws every bar as though it
  // were the whole scale. The baseline is the entire point of this form, so the
  // domain is forced to contain it and to be symmetric about it.
  const largest = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  const bound = largest * 1.15;

  return (
    <div className="px-5 py-5">
      <p className="text-[11px] text-graphite">
        Spend change, {previous.label} → {current.label}
      </p>
      <div className="mt-2 h-[160px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 40, bottom: 0, left: 8 }}>
            <CartesianGrid stroke={RULE} horizontal={false} />
            <XAxis
              type="number"
              {...AXIS}
              domain={[-bound, bound]}
              // Explicit ticks, because the baseline is the reference the whole
              // form depends on and an auto-generated scale had put it between
              // two unlabelled gridlines.
              ticks={[-bound, -bound / 2, 0, bound / 2, bound]}
              tickFormatter={(v: number) =>
                v === 0 ? '0' : `${v < 0 ? '−' : '+'}${formatCurrency(Math.abs(v), currency)}`
              }
            />
            <YAxis type="category" dataKey="label" {...AXIS} width={96} />
            <ReferenceLine x={0} stroke={INK} strokeWidth={1} />
            <Tooltip
              cursor={{ fill: 'rgba(0,0,0,0.03)' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0]!.payload as (typeof rows)[number];
                return (
                  <TooltipBox
                    title={r.label}
                    rows={[
                      ['change', `${r.d.sign}${formatCurrency(Math.abs(r.value), currency)}`],
                      ['relative', formatDelta(r.d)],
                    ]}
                  />
                );
              }}
            />
            {/*
              Spend is not good or bad on its own — it depends entirely on what
              it bought, which is the next chart up. So this carries the sign and
              the side of the baseline and stops there, rather than colouring a
              cut in spend green. Only a metric with a configured
              improvement_direction earns the ahead/shortfall treatment.
            */}
            <Bar dataKey="value" isAnimationActive={false} radius={[0, 4, 4, 0]} fill={GRAPHITE} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-2 space-y-1">
        {rows.map((r) => (
          <li key={r.platform} className="text-[11px] tabular-nums text-graphite">
            <span className="text-ink">{r.label}</span> {r.d.sign}
            {formatCurrency(Math.abs(r.value), currency)} · {formatDelta(r.d)}
          </li>
        ))}
      </ul>
      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-graphite">
        A change in spend is reported with its sign and nothing more. Spending less is not an
        improvement and spending more is not a failure — what it bought decides that, and that is
        the cost-per-deal chart above.
      </p>
    </div>
  );
}
