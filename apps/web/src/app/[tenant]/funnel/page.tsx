import { Download } from 'lucide-react';
import { AutoRefresh } from '@/components/shell/AutoRefresh';
import {
  canAdministerTenant,
  formatCount,
  formatRate,
  tenantDay,
  trailingMonths,
  type AttributionModel,
} from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine, Grid } from '@/components/ui/Card';
import { ButtonLink } from '@/components/ui/Button';
import { Segmented, segments } from '@/components/ui/Segmented';
import { AttributionModelToggle } from '@/components/AttributionModelToggle';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { rangeLinks, rangeParams, resolvePageRange } from '@/lib/range';
import { Badge, NotMeasuredBadge } from '@/components/ui/Badge';
import { NotMeasuredCard } from '@/components/NotMeasuredCard';
import {
  coverageFor,
  isUnmeasured,
  notMeasuredReason,
  throughNote,
} from '@/lib/coverage';
import { InfoTip } from '@/components/ui/InfoTip';
import { Progress } from '@/components/ui/Progress';
import { MethodDrawer, MethodNotesForPrint, type MethodNote } from '@/components/ui/Drawer';
import { PageMeta, TopBar } from '@/components/shell/TopBar';
import { PrintButton, SyncNowButton } from '@/components/shell/actions';
import { FunnelStages } from '@/components/FunnelStages';
import { DataQualityCard } from '@/components/DataQualityCard';
import { StackedBars } from '@/components/charts/Bars';
import {
  platformLabel,
} from '@/lib/reporting';
import { DeclineCard } from '@/components/DeclineCard';
import { BREAKDOWN_DIMENSIONS, type BreakdownRow } from '@/lib/breakdown';
import { Suspense } from 'react';
import { SectionSkeleton } from '@/components/ui/SectionSkeleton';
import { monthBars, monthsOf } from '@/lib/month-bars';

import { LenderOutcomes } from '@/components/LenderOutcomes';
import { CallTracking } from '@/components/CallTracking';

import { requireTenant } from '@/lib/tenant';
import { alowareConnectedThreshold, breakdownAvailability, breakdownRows, callReport, dataQuality, declineReasonSummary, loadMetrics, monthlyPerformance, sourcesThrough, submissionReport, windowBuckets } from '@/lib/cached-reports';

export const metadata = { title: 'Funnel' };

const MODELS = [
  { key: 'last_touch', label: 'Last touch' },
  { key: 'first_touch', label: 'First touch' },
];

/**
 * The funnel.
 *
 * The stage flow is drawn from configuration even with no data behind it, which
 * is the point: the engine reads `funnel_stages`, so a tenant running
 * Lead → Demo → Trial → Subscription gets the same screen with no code change.
 * "Offer rate" is `stage_conversion_rate(n, n+1)` over whatever stages a tenant
 * happens to have configured.
 *
 * The population selector includes "Unattributed" rather than treating it as a
 * hidden remainder: those deals are a real population with a real funnel, and
 * leaving them out of the picker would make every channel look like the whole
 * business. Both halves of every rate come from the selected population.
 */
export default async function Funnel({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{
    channel?: string;
    model?: string;
    from?: string;
    to?: string;
    preset?: string;
    /** Read only so a link made before the date picker existed still works. */
    days?: string;
    dim?: string;
  }>;
}) {
  const { tenant: slug } = await params;
  const query = await searchParams;
  const session = await requireTenant(slug);
  // Zeeraa staff see the data-quality working list; a client does not.
  const staff = canAdministerTenant(session.tenant.role);

  const model: AttributionModel = query.model === 'first_touch' ? 'first_touch' : 'last_touch';
  const { range, preset, problem, today, earliest } = await resolvePageRange(session, query);

  // Call tracking streams in its own boundary below; its report is started
  // here and awaited there.
  const callsP = alowareConnectedThreshold(session).then((threshold) => callReport(session, range, threshold));
  const [data, quality, buckets, metrics, submissions, through, declineReasons] =
    await Promise.all([
    monthlyPerformance(session, range, model),
    dataQuality(session),
    // `declined` is a stage event but not a configured funnel stage, so it is
    // absent from the stage totals and has to be read from the buckets.
    windowBuckets(session, trailingMonths(today, 12), 'month', model),
    loadMetrics(session),
    submissionReport(session, range),
    sourcesThrough(session),
    declineReasonSummary(session, range),
  ]);

  // No zeros for a range past a source's last read — see `lib/coverage.ts`.
  // Everything here but the calls is Salesforce; calls also need the leads
  // they are matched to, so they need both.
  const cover = coverageFor(through, range);
  const crmOut = isUnmeasured(cover.crm);
  const crmWhy = notMeasuredReason(cover.crm, 'Salesforce');
  const callsOut = crmOut || isUnmeasured(cover.calls);
  const callsWhy = crmOut ? crmWhy : notMeasuredReason(cover.calls, 'Call tracking');
  const crmNote = throughNote(cover.crm, 'Salesforce');

  /**
   * Declines per month, over the picked window and nothing else.
   *
   * Each deal is placed once, in the month of its first decline inside the
   * window (`declines.byMonth`), so the bars sum to the headline beside them.
   * The first and last months are marked partial where the window cuts them.
   */
  const declinesByMonth = new Map(data.declines.byMonth.map((m) => [m.month, m.deals]));
  const declineBars = monthBars(
    monthsOf(range).map((month) => ({ month, value: declinesByMonth.get(month) ?? 0 })),
    { firstDay: range.start, lastDay: range.end, today },
  );

  const populations = [
    { key: 'all', label: 'All sources', counts: data.total.stages },
    ...data.channels.map((c) => ({ key: c.platform, label: c.label, counts: c.stages })),
    { key: 'unattributed', label: data.unattributed.label, counts: data.unattributed.stages },
  ];
  const population = populations.find((p) => p.key === query.channel) ?? populations[0]!;

  const channelKeys = data.channels.map((c) => c.platform);
  const measurable = data.stages.filter((s) => !data.stageStatus[s.key]?.blocked);

  /*
   * The breakdown: only the dimensions this period's leads carry. A tab that
   * can only say "not measured" is a dead control, so it is not drawn.
   */

  const notes: MethodNote[] = [
    {
      heading: 'Both halves of every rate',
      body:
        `Every rate on this screen divides ${population.label.toLowerCase()}'s numerator by ` +
        `${population.label.toLowerCase()}'s denominator. A channel's rate is never its own ` +
        `numerator over everybody's denominator — that number improves whenever a different ` +
        `channel has a good month.`,
    },
    {
      heading: 'Rates across a grain boundary',
      body:
        'The first stage counts inbound leads and the rest count opportunities. A rate that ' +
        'crosses that boundary is a different kind of statement from one inside a grain, and the ' +
        'chip that carries it says so.',
    },
    {
      heading: 'Rates across a stage nobody measures',
      body:
        'Where a blocked stage sits between two measured ones, the chip carries the transition ' +
        'that can still be measured and names what it spans. A gap in the instrumentation is not ' +
        'a gap in the funnel.',
    },
    ...(staff ? quality : []).map((item) => ({
      heading: item.name,
      body: item.detail || item.summary,
      detail: item.since
        ? `Outstanding since ${item.since.toISOString().slice(0, 10)}.`
        : undefined,
    })),
  ];

  const base = `/${slug}/funnel`;
  const { preserve, presetHref } = rangeLinks(base, {
    channel: population.key,
    model,
    ...(typeof query.dim === 'string' ? { dim: query.dim } : {}),
  });
  const active = {
    channel: population.key,
    model,
    ...(typeof query.dim === 'string' ? { dim: query.dim } : {}),
    ...rangeParams(range),
  };

  return (
    <>
      <TopBar tenant={session.tenant} viewer={session.viewer} title="Funnel">
        <DateRangePicker
          range={range}
          preset={preset}
          presetHref={presetHref}
          preserve={preserve}
          problem={problem}
          earliest={earliest}
          today={today}
        />
        <Segmented
          label="Population"
          active={population.key}
          options={segments(base, active, 'channel', populations)}
        />
        <AttributionModelToggle active={model} options={segments(base, active, 'model', MODELS)} />
        <ButtonLink
          href={`/api/export/${slug}/funnel?${new URLSearchParams({ model, ...rangeParams(range) }).toString()}`}
        >
          <Download aria-hidden="true" className="h-4 w-4" />
          Export CSV
        </ButtonLink>
        <PrintButton />
        {canAdministerTenant(session.tenant.role) && (
          <SyncNowButton slug={slug} platform="salesforce" />
        )}
      </TopBar>

      <PageMeta>
        <AutoRefresh />
        <MethodDrawer notes={notes} title={`${population.label} · ${range.start} to ${range.end}`} />
      </PageMeta>

      <Grid>
        <Card span={12} dataTour="funnel">
          <CardHeader
            title="Stage flow"
            subtitle={`${population.label} · ${range.start} to ${range.end} · ${
              model === 'last_touch' ? 'last touch' : 'first touch'
            }${crmNote}`}
            controls={
              data.stages.length - measurable.length > 0 ? (
                <Badge tone="warn">
                  {data.stages.length - measurable.length} of {data.stages.length} not measured
                </Badge>
              ) : undefined
            }
          />
          {crmOut ? (
            <CardBody>
              <EmptyLine action={<NotMeasuredBadge />}>{crmWhy}</EmptyLine>
            </CardBody>
          ) : (
            <FunnelStages
              data={data}
              counts={population.counts}
              populationLabel={population.label}
            />
          )}
        </Card>

        {callsOut ? (
          <NotMeasuredCard title="Call tracking" subtitle="Aloware" reason={callsWhy} />
        ) : (
          <Suspense fallback={<SectionSkeleton title="Call tracking" rows={5} />}>
            <CallsSection report={callsP} today={today} />
          </Suspense>
        )}

        {/*
          The chart and the decline card share the left column rather than
          each taking their own grid row. Data quality is the taller card, so
          a decline card placed after it started a new row and left a void the
          height of the chart under the chart — which reads as a screen that
          failed to finish loading.
        */}
        <div className={`col-span-12 flex flex-col gap-6 ${staff ? 'lg:col-span-8' : ''}`}>
          {crmOut ? (
            <>
              <NotMeasuredCard title="Stage by channel" reason={crmWhy} className="w-full" />
              <NotMeasuredCard title="Declines" reason={crmWhy} className="w-full" />
            </>
          ) : (
          <>
          <Card selfStart className="w-full">
          <CardHeader
            title="Stage by channel"
            subtitle="Direct & other is its own segment, never folded into a source"
          />
          <CardBody className="flex-1">
            <StackedBars
              id="funnel-stage-by-channel"
              rows={measurable.map((stage) => ({
                label: stage.label,
                byChannel: Object.fromEntries(
                  data.channels.map((c) => [c.platform, c.stages[stage.key] ?? 0]),
                ),
                unattributed: data.unattributed.stages[stage.key] ?? 0,
              }))}
              channels={channelKeys}
              channelLabels={Object.fromEntries(
                channelKeys.map((c) => [c, platformLabel(c)]),
              )}
              format={{ kind: 'count' }}
              height={280}
            />
          </CardBody>
          </Card>

          <DeclineCard
            bars={declineBars}
            total={data.declines.deals}
            range={range}
            reasons={declineReasons}
          />
          </>
          )}
        </div>

        {staff && <DataQualityCard items={quality} span={4} />}

        {crmOut ? (
          <NotMeasuredCard title="Lender outcomes" reason={crmWhy} />
        ) : (
          <LenderOutcomes
            report={submissions}
            span={12}
            gateFor={(decided) => metrics.population('submission_offer_rate', decided)}
          />
        )}

        {/* Streamed: the slowest statement on this screen, and the last card. */}
        {!crmOut && (
          <Suspense fallback={<SectionSkeleton title="Breakdown" rows={6} />}>
            <BreakdownSection
              session={session}
              range={range}
              stages={measurable.map((s) => ({ key: s.key, label: s.label, source: s.source }))}
              requested={typeof query.dim === 'string' ? query.dim : undefined}
              base={base}
              active={active}
            />
          </Suspense>
        )}
      </Grid>

      <MethodNotesForPrint notes={notes} />
    </>
  );
}

/** Call tracking, streamed: the calls report is the slowest in the page's first batch. */
async function CallsSection({ report, today }: { report: ReturnType<typeof callReport>; today: string }) {
  return <CallTracking report={await report} span={12} today={today} />;
}

/**
 * The Breakdown card: only the dimensions this period's leads carry, so a tab
 * with nothing behind it is not drawn. Its own async section, so the rest of
 * the funnel does not wait for it.
 */
async function BreakdownSection({
  session,
  range,
  stages,
  requested,
  base,
  active,
}: {
  session: Awaited<ReturnType<typeof requireTenant>>;
  range: { start: string; end: string };
  stages: { key: string; label: string; source?: string }[];
  requested: string | undefined;
  base: string;
  active: Parameters<typeof segments>[1];
}) {
  const available = await breakdownAvailability(session, range);
  const dimensions = BREAKDOWN_DIMENSIONS.filter((d) => available.includes(d.key));
  const dimension = dimensions.find((d) => d.key === requested) ?? dimensions[0] ?? null;
  if (!dimension) return null;
  const rows = await breakdownRows(
    session,
    range,
    dimension.key,
    stages.map((s) => ({ key: s.key, source: s.source })),
  );
  return (
    <Card span={12}>
      <CardHeader
        title="Breakdown"
        subtitle={`${dimension.label} · every source`}
        controls={<Segmented label="Dimension" active={dimension.key} options={segments(base, active, 'dim', dimensions)} />}
      />
      <BreakdownPanel dimension={dimension} stages={stages.map((s) => ({ key: s.key, label: s.label }))} rows={rows} />
    </Card>
  );
}

/**
 * One row per value of the dimension, the funnel's stages across. A lead with
 * no value is the "Not recorded" row at the bottom, so every column still adds
 * up to the funnel above it.
 */
function BreakdownPanel({
  dimension,
  stages,
  rows,
}: {
  dimension: { key: string; label: string };
  stages: { key: string; label: string }[];
  rows: BreakdownRow[];
}) {
  return (
    <div className="scroll-x min-w-0 overflow-x-auto border-t border-border">
      <table className="w-full min-w-[640px] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border text-left text-[12px] font-semibold text-text-2">
            <th scope="col" className="px-5 py-2.5 font-semibold">
              {dimension.label}
            </th>
            {stages.map((stage) => (
              <th key={stage.key} scope="col" className="numeric px-3 py-2.5 font-semibold">
                {stage.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className={`border-b border-border last:border-b-0 ${row.notRecorded ? 'bg-canvas/60' : ''}`}>
              <th
                scope="row"
                className={`max-w-[280px] truncate px-5 py-2.5 text-left font-medium ${row.notRecorded ? 'text-text-2' : 'text-text'}`}
                title={row.label}
              >
                {row.label}
              </th>
              {stages.map((stage) => (
                <td key={stage.key} className="numeric px-3 py-2.5 tabular text-text">
                  {formatCount(row.counts[stage.key] ?? 0)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
