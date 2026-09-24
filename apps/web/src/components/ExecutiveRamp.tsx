import { formatCount, type RampTimeline } from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { CostPerDealFigure } from '@/components/CostPerDeal';
import { RampTimelineChart } from '@/components/charts/RampTimelineChart';
import { chartPoint, costCoverage, monthName, renderer, targetRenderer, type RampPanel } from '@/components/RampCard';
import type { ScorecardRow } from '@/lib/ramp-panels';

/**
 * The engagement ramp as a client reads it: four figures against this month's
 * target, and one chart.
 *
 * Deliberately bare. No legend, no basis line, no badge stack: the chart labels
 * its own lines, a month with no figure is a gap with its reason on hover, and
 * every definition is in the page's one "How this is measured" drawer. The
 * other contracted curves are on Monthly performance.
 */
export function RampScorecard({
  channel,
  rows,
  monthLabel,
  elapsedDays,
  monthDays,
  currency,
  note = '',
}: {
  channel: string;
  rows: ScorecardRow[];
  /** `Sep 2026`. */
  monthLabel: string;
  elapsedDays: number;
  monthDays: number;
  currency: string;
  /** Where a source's last read falls short of today: ` · Salesforce synced through …`. */
  note?: string;
}) {
  const partial = elapsedDays < monthDays;
  return (
    <Card span={12} id="ramp-scorecard" dataTour="scorecard">
      <CardHeader
        title="This month vs target"
        subtitle={`${channel} · ${monthLabel}${
          partial ? ` · month to date, ${formatCount(elapsedDays)} of ${formatCount(monthDays)} days` : ''
        }${note}`}
      />
      <dl className="grid grid-cols-1 gap-px border-t border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
        {rows.map((row) => (
          <ScoreCell key={row.metric} row={row} channel={channel} currency={currency} partial={partial} />
        ))}
      </dl>
    </Card>
  );
}

function ScoreCell({
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
      <dt className="text-[13px] font-medium text-text-2">{row.label}</dt>
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
        ) : row.metric === 'costPerFundedDeal' && actual.cost ? (
          // A cost per deal carries its coverage, always: the figure component
          // is the only way one renders.
          <CostPerDealFigure cost={actual.cost} currency={currency} channelLabel={channel} />
        ) : (
          <p className="text-[28px] font-semibold leading-[1.1] tabular text-text">
            {render(actual.value)}
          </p>
        )}
        {partial && actual.value !== null && <p className="text-[12px] text-text-3">Month to date</p>}

        <p className="mt-1 text-[13px] tabular text-text-2">
          {row.target !== null
            ? `Target ${renderTarget(row.target)}`
            : row.upcoming
              ? `Target from ${monthName(row.upcoming.month)}: ${renderTarget(row.upcoming.value)}`
              : 'No target this month'}
        </p>
        <Verdict row={row} render={render} />
      </dd>
    </div>
  );
}

/**
 * On target, or behind by how much — with an arrow for which side of the
 * target the figure is, so the verdict is never colour alone.
 */
function Verdict({ row, render }: { row: ScorecardRow; render: (v: number) => string }) {
  const { verdict } = row;
  const money = row.format.kind === 'currency';
  // Whole dollars: "$412.68 behind" is precision a monthly target does not have.
  const amount = (v: number) => render(money ? Math.round(v) : v);

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
 * The one ramp chart on the executive screen: the channel's cost per funded
 * deal, its baseline months, then the contracted curve.
 */
export function RampCostChart({ panel }: { panel: RampPanel }) {
  const timeline = panel.timeline;
  const render = renderer(panel);
  return (
    <Card span={12} id="ramp-chart" dataTour="cost-chart">
      <CardHeader title={`${panel.channel} ${panel.label.toLowerCase()}`} subtitle={timeline ? phases(timeline) : undefined} />
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

/** `Baseline Jun–Sep 2026, then the M1–M8 target`. */
function phases(timeline: RampTimeline): string {
  const baseline = timeline.points.filter((p) => p.phase === 'baseline');
  const months = timeline.points.filter((p) => p.phase === 'engagement').length;
  const short = (m: string) => monthName(m).split(' ')[0];
  const span =
    baseline.length === 0
      ? null
      : baseline.length === 1
        ? monthName(baseline[0]!.month)
        : `${short(baseline[0]!.month)}–${monthName(baseline.at(-1)!.month)}`;
  return `${span ? `Baseline ${span}, then ` : ''}the M1–M${formatCount(months)} target`;
}
