import { formatCount, formatCurrency, type RampTimeline } from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { CostPerDealFigure } from '@/components/CostPerDeal';
import { RampTimelineChart } from '@/components/charts/RampTimelineChart';
import { chartPoint, costCoverage, monthName, renderer, targetRenderer, type RampPanel } from '@/components/RampCard';
import type { ScorecardRow } from '@/lib/ramp-panels';
import { ExportButton } from '@/components/export/ExportScope';

/**
 * The scorecard's cells: one column on a phone, two on a tablet, all of them
 * on a wide screen. A last cell alone in its row spans it, so no grey gap
 * shows through the hairlines.
 */
export const SCORE_GRID =
  'grid grid-cols-1 gap-px border-t border-border bg-border sm:grid-cols-2 xl:auto-cols-fr xl:grid-flow-col xl:grid-cols-none ' +
  'sm:[&>*:last-child:nth-child(odd)]:col-span-2 xl:[&>*:last-child:nth-child(odd)]:col-span-1';

export function ScoreCell({
  row,
  channel,
  currency,
  partial,
}: {
  row: ScorecardRow;
  channel: string;
  currency: string;
  partial: boolean;
}) {
  const render = renderer({ format: row.format } as RampPanel);
  const renderTarget = targetRenderer({ format: row.format } as RampPanel);
  const { actual } = row;

  return (
    <div className="flex min-w-0 flex-col gap-1 bg-surface px-5 py-4">
      <dt className="flex items-center gap-1.5 text-[13px] font-medium text-text-2">
        {row.label}
        {row.info && (
          <InfoTip label={`How ${row.label.toLowerCase()} is calculated`} align="start">
            {row.info}
          </InfoTip>
        )}
      </dt>
      <dd className="flex min-w-0 flex-col gap-1">
        {actual.value === null && actual.empty ? (
          <p className="py-1.5 text-[15px] font-medium text-text-3">{actual.reason?.replace(/\.$/, '')}</p>
        ) : actual.value === null ? (
          <span className="flex items-center gap-2 py-1.5">
            <Badge tone="warn" title={actual.reason ?? undefined}>
              Not measured
            </Badge>
            <span className="sr-only">{actual.reason}</span>
          </span>
        ) : actual.cost && (row.metric === 'costPerFundedDeal' || row.cost) ? (
          // A cost per deal carries its coverage, always: the figure component
          // is the only way one renders.
          <CostPerDealFigure
            cost={actual.cost}
            currency={currency}
            channelLabel={channel}
            noun={row.cost?.noun}
            whole={row.cost?.whole}
            explanation={
              row.cost
                ? row.cost.explanation(formatCurrency(actual.cost.channelSpend, currency), formatCount(actual.cost.attributedDeals))
                : undefined
            }
          />
        ) : (
          <p className="text-[28px] font-semibold leading-[1.1] tabular text-text">
            {render(actual.value)}
          </p>
        )}
        {partial && actual.value !== null && <p className="text-[12px] text-text-3">Month to date</p>}

        {!row.untargeted && (
          <p className="mt-1 text-[13px] tabular text-text-2">
            {row.target !== null
              ? `Target ${row.targetHigh !== null ? `${renderTarget(row.target)}–${renderTarget(row.targetHigh)}` : renderTarget(row.target)}`
              : row.upcoming
                ? `Target from ${monthName(row.upcoming.month)}: ${renderTarget(row.upcoming.value)}`
                : 'No target this month'}
          </p>
        )}
        {!row.untargeted && row.verdict && <Verdict row={row} verdict={row.verdict} render={render} renderWhole={renderTarget} />}
      </dd>
    </div>
  );
}

/**
 * On target, or behind by how much — with an arrow for which side of the
 * target the figure is, so the verdict is never colour alone.
 */
function Verdict({
  row,
  verdict,
  render,
  renderWhole,
}: {
  row: ScorecardRow;
  verdict: NonNullable<ScorecardRow['verdict']>;
  render: (v: number) => string;
  /** The target's renderer: whole dollars for money, `render` otherwise. */
  renderWhole: (v: number) => string;
}) {
  // Whole dollars: "$412.68 behind" is precision a monthly target does not
  // have. Rounding before `render` was not enough — it still printed "$253.00".
  const amount = (v: number) => (row.format.kind === 'currency' ? renderWhole(v) : render(v));

  switch (verdict.state) {
    case 'no_target':
      // Before M1 the target line already names the month it starts.
      return row.upcoming ? null : <p className="text-[13px] text-text-3">{verdict.reason}</p>;
    case 'not_measured':
      return null;
    case 'too_early':
      return (
        <p className="text-[13px] text-text-3" title={verdict.reason}>
          Too early to compare
          <span className="sr-only"> — {verdict.reason}</span>
        </p>
      );
    case 'on_target':
      return <p className="text-[13px] font-medium text-text-2">{verdict.paced ? 'On pace' : 'On target'}</p>;
    case 'behind': {
      // Above target for a cost, below it for a count.
      const above = row.actual.value !== null && row.target !== null && row.actual.value > row.target;
      return (
        <p className="text-[13px] font-medium tabular text-down-text">
          <span aria-hidden="true">{above ? '↑' : '↓'} </span>
          Behind {verdict.paced ? 'pace ' : ''}by {amount(verdict.by)}
        </p>
      );
    }
    case 'over':
    case 'under':
      return (
        <p className="text-[13px] font-medium tabular text-text-2">
          <span aria-hidden="true">{verdict.state === 'over' ? '↑' : '↓'} </span>
          {verdict.state === 'over' ? 'Over' : 'Under'} {verdict.paced ? 'pace ' : ''}by {amount(verdict.by)}
        </p>
      );
  }
}

/**
 * The one ramp chart on the executive screen: cost per funded deal across
 * every source, its baseline months before Zeeraa, then the contract's target.
 */
export function RampCostChart({ panel, title }: { panel: RampPanel; title?: string }) {
  const timeline = panel.timeline;
  const render = renderer(panel);
  return (
    <Card span={12} id="ramp-chart" dataTour="cost-chart">
      <CardHeader
        title={title ?? panel.label}
        subtitle={timeline ? phases(timeline) : undefined}
        controls={<ExportButton datasets={['ramp']} />}
      />
      <CardBody>
        {!panel.series.contracted || !timeline ? (
          <EmptyLine>{panel.missing}</EmptyLine>
        ) : (
          <RampTimelineChart
            id={`ramp-timeline-${panel.metric}`}
            points={timeline.points.map((p, i) => ({
              ...chartPoint(p, timeline.points[i - 1]),
              coverage: p.cost ? costCoverage(p.cost, render) : null,
            }))}
            format={panel.format}
            channel={panel.channel}
            caption={panel.label}
            height={260}
            showLegend={false}
            labelActual
          />
        )}
      </CardBody>
    </Card>
  );
}

/** `Baseline Jun–Sep 2026, before Zeeraa; then the contract's target`. */
function phases(timeline: RampTimeline): string {
  const baseline = timeline.points.filter((p) => p.phase === 'baseline');
  const short = (m: string) => monthName(m).split(' ')[0];
  const span =
    baseline.length === 0
      ? null
      : baseline.length === 1
        ? monthName(baseline[0]!.month)
        : `${short(baseline[0]!.month)}–${monthName(baseline.at(-1)!.month)}`;
  return `${span ? `Baseline ${span}, before Zeeraa; then ` : ''}the contract's target`;
}
