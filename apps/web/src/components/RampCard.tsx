import {
  formatCount,
  formatCurrency,
  formatProjection,
  formatTargetCurrency,
  type ImprovementDirection,
  type RampMetricKey,
  type RampSeries,
  type ChannelCostPerDeal,
  type RampTimeline,
  type TimelinePoint,
} from '@zeeraa/core';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { RampChart } from '@/components/charts/RampChart';
import { RampLegend, RampTimelineChart, type RampTimelineChartPoint } from '@/components/charts/RampTimelineChart';
import type { FormatSpec } from '@/components/charts/format-spec';

export type RampPanel = {
  metric: RampMetricKey;
  label: string;
  series: RampSeries;
  format: FormatSpec;
  /** From the metric's own declaration. Null renders the line uncoloured. */
  direction: ImprovementDirection | null;
  /** What has to happen for this curve to exist, where it does not. */
  missing: string;
  /**
   * The same curve on the calendar, with the baseline before it — once the
   * start month is recorded. Null keeps the panel on the M1–Mn axis.
   */
  timeline: RampTimeline | null;
  /** The channel the model contracts this for, and the actual is scoped to. */
  channel: string;
  /** What the actual divides or counts, in words: stated under the title. */
  basis: string;
};

/**
 * The engagement ramp — what this client signed, and where they are against it.
 *
 * The one thing on the briefing that is a *commitment* rather than a
 * measurement. Kept quiet on purpose: one legend for the section, not one per
 * chart; a month with no figure is a hollow marker on the axis with its reason
 * on hover and one footnote line, not a stack of badges. Monthly performance
 * draws it; the executive screen draws `RampScorecard` and `RampCostChart`
 * instead, from the same panels.
 *
 * Before the start month is recorded the curves are drawn on an M1–Mn axis
 * and the other metrics summarised in a line each, because a curve with
 * nothing against it is a large empty rectangle.
 */
export function RampCard({
  title = 'Engagement ramp',
  platformLabel,
  panels,
  startMonth,
  compactWhenUnstarted = [],
  span = 12,
}: {
  title?: string;
  platformLabel: string;
  /** The curves drawn as charts. */
  panels: RampPanel[];
  /** `2026-10`, or null while the contract start is unrecorded. */
  startMonth: string | null;
  /** Summarised in a line each while there is no start month. */
  compactWhenUnstarted?: RampPanel[];
  span?: 8 | 12;
}) {
  const months = panels[0]?.series.points.length ?? 0;
  const charted = startMonth !== null && panels.some((p) => p.timeline && p.series.contracted);
  const anyPartial = panels.some((p) => p.timeline?.points.some((x) => x.status === 'partial'));
  const anyUnmeasured = panels.some((p) => p.timeline?.points.some((x) => x.status === 'not_measured'));

  return (
    <Card span={span}>
      <CardHeader
        title={title}
        subtitle={
          months > 0
            ? `${platformLabel} · M1–M${months} of the contracted model`
            : `${platformLabel} · no contracted model recorded`
        }
        controls={
          startMonth === null ? (
            <Badge tone="warn">Start month not set</Badge>
          ) : (
            <Badge tone="neutral">M1 is {monthName(startMonth)}</Badge>
          )
        }
        info={
          <InfoTip label="How the ramp is tracked" align="start">
            {startMonth === null
              ? 'The contract commits a figure for each month of the engagement, so the axis is M1–M8 until the start month is recorded; nothing else says which calendar month M1 is.'
              : `Each target is ${platformLabel} only, from the engagement model, and each actual is ${platformLabel}'s own spend and attributed deals. The baseline runs from the first month ${platformLabel} spend was read.`}
          </InfoTip>
        }
      />

      {charted && (
        <div className="border-t border-border px-5 py-3">
          <RampLegend channel={platformLabel} partial={anyPartial} unmeasured={anyUnmeasured} />
        </div>
      )}

      <div className={`grid gap-px bg-border ${charted ? '' : 'border-t border-border'} lg:grid-cols-2`}>
        {panels.map((panel) => (
          <RampPanelBody key={panel.metric} panel={panel} startMonth={startMonth} />
        ))}
      </div>

      {startMonth === null && compactWhenUnstarted.length > 0 && (
        <CardBody className="border-t border-border pt-4">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
            {compactWhenUnstarted.map((panel) => (
              <div key={panel.metric} className="min-w-0">
                <dt className="flex items-center gap-1.5 text-[13px] font-medium text-text-2">
                  {panel.label}
                  {!panel.series.contracted && (
                    <InfoTip label={`Why ${panel.label} has no curve`} align="start">
                      {panel.missing}
                    </InfoTip>
                  )}
                </dt>
                <dd className="mt-1 text-[13px] leading-snug tabular text-text-3">
                  {panel.series.contracted ? <CurveSummary panel={panel} /> : <Badge tone="warn">Not recorded</Badge>}
                </dd>
              </div>
            ))}
          </dl>
        </CardBody>
      )}
    </Card>
  );
}

/** The quiet Not measured mark, matching the one on the chart axis. */
function HollowMarker() {
  return (
    <svg width="10" height="10" aria-label="Not measured" role="img">
      <circle cx="5" cy="5" r="3.5" fill="none" stroke="var(--color-warn)" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * One tracked metric: the chart where a curve exists, the reason where it does
 * not.
 *
 * An absent curve is a dependency on Zeeraa, not a fault in the data, so it
 * gets the amber badge and the sentence rather than an empty plot area. A chart
 * axis with no series on it is the most confusing thing this screen could draw:
 * it looks like a measurement that came back zero.
 */
function RampPanelBody({ panel, startMonth }: { panel: RampPanel; startMonth: string | null }) {
  const { series } = panel;

  return (
    <section className="flex min-w-0 flex-col gap-2 bg-surface px-5 py-4 lg:odd:last:col-span-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-[13px] font-semibold text-text">
          {panel.label}
          {panel.timeline && <span className="font-normal text-text-2"> · {panel.channel}</span>}
        </h3>
        {series.contracted ? (
          <p className="text-[12px] tabular text-text-3">
            <CurveSummary panel={panel} />
          </p>
        ) : (
          <Badge tone="warn">Not recorded</Badge>
        )}
      </div>
      {panel.timeline && <p className="-mt-1 text-[12px] leading-snug text-text-3">{panel.basis}</p>}

      {!series.contracted ? (
        <p className="text-[13px] leading-snug text-text-3">{panel.missing}</p>
      ) : panel.timeline ? (
        <TimelineBody panel={panel} timeline={panel.timeline} />
      ) : (
        <>
          <RampChart
            id={`ramp-${panel.metric}`}
            points={series.points.map((point) => ({
              label: point.label,
              target: point.target,
              actual: point.actual,
              month: point.month ? monthName(point.month) : null,
              gap: point.gap
                ? { absolute: point.gap.absolute, assessment: point.gap.assessment }
                : null,
            }))}
            format={panel.format}
            tone={toneFor(series, panel.direction)}
            height={188}
          />

          {/*
            One line under the chart, and it is the state of the tracking rather
            than a caveat about it. "No actual is plotted" is the finding when a
            contract has been signed and nobody has recorded when it starts.
          */}
          <p className="text-[12px] leading-snug text-text-3">
            {startMonth === null
              ? 'The contract start month is not recorded, so the commitment is shown with no actual against it.'
              : series.measured
                ? latestGapLine(panel)
                : 'No completed month in the ramp has a measured figure yet.'}
            {' '}
            The month in progress is not plotted — a ramp contracts a monthly
            result, and three weeks of one is not that.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The calendar ramp: the chart, the months with no figure named in one line,
 * and the gap for each finished month.
 *
 * The gap is written out rather than left to the bars, with its arrow and its
 * sign, because a delta is never colour alone.
 */
function TimelineBody({ panel, timeline }: { panel: RampPanel; timeline: RampTimeline }) {
  const render = renderer(panel);
  // Whole dollars on a gap: "$922.68 under" is precision the monthly target
  // does not have.
  const money = panel.format.kind === 'currency';
  const unmeasured = groupReasons(timeline.points.filter((p) => p.status === 'not_measured'));
  const inProgressUnmeasured = timeline.points.find(
    (p) => p.inProgress && p.status === 'not_measured',
  );
  const partial = timeline.points.find((p) => p.status === 'partial');

  return (
    <>
      <RampTimelineChart
        id={`ramp-timeline-${panel.metric}`}
        points={timeline.points.map((p, i) => ({
          ...chartPoint(p, timeline.points[i - 1]),
          coverage: p.cost ? costCoverage(p.cost, render) : null,
        }))}
        format={panel.format}
        channel={panel.channel}
        caption={panel.label}
        height={panel.metric === 'costPerFundedDeal' || panel.metric === 'cpa' ? 232 : 208}
        showLegend={false}
      />

      {timeline.finished.length === 0 ? (
        <p className="text-[12px] leading-snug text-text-3">
          No engagement month has finished yet · M1 is {monthName(timeline.startMonth)}.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] tabular text-text-2">
          {timeline.finished.map((p) => {
            const gap = p.gap!;
            const arrow = gap.absolute > 0 ? '↑' : gap.absolute < 0 ? '↓' : '→';
            const sign = gap.absolute > 0 ? '+' : gap.absolute < 0 ? '−' : '';
            const tone = !p.assessed
              ? 'text-text-2'
              : gap.assessment === 'ahead'
                ? 'text-up-text'
                : gap.assessment === 'shortfall'
                  ? 'text-down-text'
                  : 'text-text-2';
            const word = !p.assessed
              ? gap.absolute > 0
                ? 'over'
                : gap.absolute < 0
                  ? 'under'
                  : 'on target'
              : gap.assessment === 'ahead'
                ? 'ahead'
                : gap.assessment === 'shortfall'
                  ? 'behind'
                  : 'on target';
            return (
              <li key={p.month}>
                M{p.monthIndex} {render(gap.actual)} vs {targetRenderer(panel)(gap.target)}{' '}
                <span className={tone}>
                  {arrow} {sign}
                  {render(money ? Math.round(Math.abs(gap.absolute)) : Math.abs(gap.absolute))} {word}
                </span>
                {/* A cost per deal carries its coverage and range, always. */}
                {p.cost && (
                  <span className="block text-[11px] text-text-3">{costCoverage(p.cost, render)}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* One footnote, not a stack of badges: the months with no figure and
          why, and the partial month if it has one. */}
      {(unmeasured.length > 0 || partial) && (
        <p className="flex items-start gap-1.5 text-[12px] leading-snug text-text-3">
          {unmeasured.length > 0 && (
            <span className="mt-[3px] shrink-0">
              <HollowMarker />
            </span>
          )}
          <span>
            {unmeasured.length > 0 && (
              <>
                Not measured:{' '}
                {unmeasured
                  .flatMap(({ months }) => months)
                  .map((m) => (m === inProgressUnmeasured?.month ? `${shortMonth(m)} (partial)` : shortMonth(m)))
                  .join(', ')}
                <InfoTip label="Why these months are not measured" align="start" className="ml-1 align-middle">
                  {unmeasured.map(({ months, reason }) => `${months.map(shortMonth).join(', ')}: ${reason}`).join(' ')}
                </InfoTip>
                {partial ? ' · ' : ''}
              </>
            )}
            {partial ? `${shortMonth(partial.month)} is partial, not compared with a target.` : ''}
          </span>
        </p>
      )}
    </>
  );
}

export function chartPoint(p: TimelinePoint, previous: TimelinePoint | undefined): RampTimelineChartPoint {
  const [year, m] = p.month.split('-');
  // The year on the first tick only: `Jan ’27` is wide enough that the axis
  // drops it at 1440, and the tooltip carries the full date.
  const yearTurns = !previous;
  return {
    key: p.month,
    label: yearTurns ? `${shortMonth(p.month)} ’${year!.slice(2)}` : shortMonth(p.month),
    title:
      p.monthIndex === null
        ? `${monthName(p.month)} · baseline${p.inProgress ? ' · partial' : ''}`
        : `M${p.monthIndex} · ${monthName(p.month)}${p.inProgress ? ' · partial' : ''}`,
    phase: p.phase,
    target: p.target,
    actual: p.actual,
    partial: p.partial,
    status: p.status,
    inProgress: p.inProgress,
    reason: p.reason,
    gap: p.gap ? { absolute: p.gap.absolute, assessment: p.gap.assessment } : null,
    assessed: p.assessed,
  };
}

/**
 * `3 attributed · 4 to no channel · range $3,678–$8,583`: what a cost per deal
 * was divided by, what it was not, and how far the uncredited deals could
 * move it. The line every cost per deal carries.
 */
export function costCoverage(cost: ChannelCostPerDeal, render: (v: number) => string): string {
  const parts = [
    `${formatCount(cost.attributedDeals)} attributed`,
    `${formatCount(cost.unattributedDeals)} to no channel`,
  ];
  if (cost.plausibleRange.low !== null && cost.plausibleRange.high !== null) {
    parts.push(`range ${render(cost.plausibleRange.low)}–${render(cost.plausibleRange.high)}`);
  }
  return parts.join(' · ');
}

/** Months sharing a reason, so the line says it once. */
function groupReasons(points: TimelinePoint[]): { months: string[]; reason: string }[] {
  const groups = new Map<string, string[]>();
  for (const p of points) {
    const reason = p.reason ?? 'No figure for this month.';
    groups.set(reason, [...(groups.get(reason) ?? []), p.month]);
  }
  return [...groups].map(([reason, months]) => ({ reason, months }));
}

/** `Oct`, from `2026-10`. */
function shortMonth(month: string): string {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year!, m! - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
}

/**
 * `$4,000 → $2,705 over 8 months`, or the count equivalent.
 *
 * A curve with holes in it says so. Spartan's budget is contracted for M1 and
 * for nothing after it, and `$30,000` on its own reads as a monthly budget
 * rather than as one month of one — which is the difference between a figure
 * the screen can pace against all year and a figure it can pace against once.
 */
function CurveSummary({ panel }: { panel: RampPanel }) {
  const { first, last, points } = panel.series;
  if (first === null) return <>Not recorded</>;

  const render = targetRenderer(panel);
  const contracted = points.filter((p) => p.target !== null);
  if (contracted.length < points.length) {
    const months = contracted.map((p) => p.label).join(', ');
    return (
      <>
        {render(first)} · {contracted.length === 1 ? `${months} only` : `${months} only`}
      </>
    );
  }

  if (last === null || first === last) return <>{render(first)}</>;
  return (
    <>
      {render(first)} → {render(last)} over {formatCount(points.length)} months
    </>
  );
}

/**
 * The most recent month with both halves, as a sentence.
 *
 * Month against month. The figure a briefing is judged on is the distance from
 * the curve in the metric's own unit, and a chart only shows that one line sits
 * above another.
 */
function latestGapLine(panel: RampPanel): string {
  const point = [...panel.series.points].reverse().find((p) => p.gap !== null);
  if (!point?.gap) return 'No month yet has both a contracted figure and a measured one.';
  const render = renderer(panel);
  const distance = render(Math.abs(point.gap.absolute));
  if (point.gap.assessment === 'level') return `${point.label} landed on its target.`;
  const side = point.gap.absolute > 0 ? 'above' : 'below';
  const verdict = point.gap.assessment === 'ahead' ? 'ahead of plan' : 'behind plan';
  return `${point.label} came in ${distance} ${side} the ${targetRenderer(panel)(point.gap.target)} target — ${verdict}.`;
}

/**
 * How the measured line is coloured: by where the series sits against its
 * curve, assessed through the metric's own direction.
 *
 * Not by the direction of travel. A rising cost is only a regression because
 * cost per funded deal declares `down`, and that declaration lives on the
 * metric.
 */
function toneFor(
  series: RampSeries,
  direction: ImprovementDirection | null,
): 'primary' | 'ahead' | 'shortfall' {
  if (!direction) return 'primary';
  const latest = [...series.points].reverse().find((p) => p.gap !== null);
  if (!latest?.gap || latest.gap.assessment === 'level') return 'primary';
  return latest.gap.assessment;
}

/**
 * How a panel's figures are written, from its own `FormatSpec`.
 *
 * Shared by every ramp surface so they cannot disagree — and so a contracted
 * 7.5 funded deals is never rounded to 8 in one of them. That rounding is the
 * exact thing migration 0021 exists to prevent, and it would be undone here by
 * a default.
 */
/** A contracted figure: as `renderer`, but whole dollars for money. */
export function targetRenderer(panel: RampPanel): (value: number) => string {
  if (panel.format.kind === 'currency') {
    const { currency } = panel.format;
    return (value) => formatTargetCurrency(value, currency);
  }
  return renderer(panel);
}

export function renderer(panel: RampPanel): (value: number) => string {
  if (panel.format.kind === 'currency') {
    const { currency } = panel.format;
    return (value) => formatCurrency(value, currency);
  }
  if (panel.format.kind === 'projection') return (value) => formatProjection(value);
  return (value) => formatCount(value);
}

/** `Jun 2026`, from `2026-06`. */
export function monthName(month: string): string {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year!, m! - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
