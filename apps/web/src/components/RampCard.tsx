import {
  formatCount,
  formatCurrency,
  type ImprovementDirection,
  type RampMetricKey,
  type RampSeries,
} from '@zeeraa/core';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { RampChart } from '@/components/charts/RampChart';
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
};

/**
 * The engagement ramp — what this client signed, and where they are against it.
 *
 * This is the top of the briefing because it is the only thing on the screen
 * that is a *commitment* rather than a measurement. Everything below reports
 * what happened; this reports what was promised and whether it is being kept.
 *
 * **Every contracted metric gets a panel, including the four with no curve.**
 * The engagement model contracts budget, CPA, approvals, cost per funded deal
 * and funded deals; only cost per funded deal has been entered, and M1's budget.
 * Rendering the other three as absent panels rather than omitting them is the
 * difference between a visible dependency somebody can close and a feature
 * nobody knows exists — the same argument the data-quality card makes, applied
 * to the contract instead of to the data.
 *
 * The two named metrics get full charts; the rest get a one-line summary,
 * because a chart of a curve nobody has entered is a large empty rectangle.
 */
export function RampCard({
  platformLabel,
  primary,
  secondary,
  compact,
  startMonth,
  span = 12,
}: {
  platformLabel: string;
  /** Cost per funded deal: the north star, and the only fully contracted curve. */
  primary: RampPanel;
  /** CPA, tracked the same way. */
  secondary: RampPanel;
  /** Budget, approvals, funded deals — one line each. */
  compact: RampPanel[];
  /** `2026-06`, or null while the contract start is unrecorded. */
  startMonth: string | null;
  span?: 8 | 12;
}) {
  const months = primary.series.points.length || secondary.series.points.length;

  return (
    <Card span={span}>
      <CardHeader
        title="Engagement ramp"
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
            The contract commits a figure for each month of the engagement, so
            the axis is M1–M8 rather than a calendar. The actual is plotted only
            once the start month is recorded, because nothing else says which
            calendar month M1 is.
          </InfoTip>
        }
      />

      <div className="grid gap-px border-t border-border bg-border lg:grid-cols-2">
        <RampPanelBody panel={primary} startMonth={startMonth} />
        <RampPanelBody panel={secondary} startMonth={startMonth} />
      </div>

      {compact.length > 0 && (
        <CardBody className="border-t border-border pt-4">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
            {compact.map((panel) => (
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
                  {panel.series.contracted ? (
                    <CurveSummary panel={panel} />
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <Badge tone="warn">Not recorded</Badge>
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </CardBody>
      )}
    </Card>
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
    <section className="flex min-w-0 flex-col gap-2 bg-surface px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-[13px] font-semibold text-text">{panel.label}</h3>
        {series.contracted ? (
          <p className="text-[12px] tabular text-text-3">
            <CurveSummary panel={panel} />
          </p>
        ) : (
          <Badge tone="warn">Not recorded</Badge>
        )}
      </div>

      {!series.contracted ? (
        <p className="text-[13px] leading-snug text-text-3">{panel.missing}</p>
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

  const render = (value: number) =>
    panel.format.kind === 'currency'
      ? formatCurrency(value, panel.format.currency)
      : formatCount(value);

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
  const render = (value: number) =>
    panel.format.kind === 'currency'
      ? formatCurrency(value, panel.format.currency)
      : formatCount(value);
  const distance = render(Math.abs(point.gap.absolute));
  if (point.gap.assessment === 'level') return `${point.label} landed on its target.`;
  const side = point.gap.absolute > 0 ? 'above' : 'below';
  const verdict = point.gap.assessment === 'ahead' ? 'ahead of plan' : 'behind plan';
  return `${point.label} came in ${distance} ${side} the ${render(point.gap.target)} target — ${verdict}.`;
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

/** `Jun 2026`, from `2026-06`. */
function monthName(month: string): string {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year!, m! - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
