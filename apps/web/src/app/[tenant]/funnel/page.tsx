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
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { rangeLinks, rangeParams, resolvePageRange } from '@/lib/range';
import { Badge, NotMeasuredBadge } from '@/components/ui/Badge';
import { NotMeasuredCard } from '@/components/NotMeasuredCard';
import {
  coverageFor,
  isUnmeasured,
  notMeasuredReason,
  sourcesThrough,
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
  callReport,
  monthlyPerformance,
  platformLabel,
  submissionReport,
} from '@/lib/reporting';
import { DeclineCard } from '@/components/DeclineCard';
import { LenderOutcomes } from '@/components/LenderOutcomes';
import { CallTracking } from '@/components/CallTracking';
import {
  alowareConnectedThreshold,
  dataQuality,
  loadMetrics,
  maxRateLeakage,
  windowBuckets,
} from '@/lib/dashboard';
import { requireTenant } from '@/lib/tenant';

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

  const model: AttributionModel = query.model === 'first_touch' ? 'first_touch' : 'last_touch';
  const { range, preset, problem, today, earliest } = await resolvePageRange(session, query);

  const [data, quality, buckets, metrics, submissions, leakageTolerance, calls, through] =
    await Promise.all([
    monthlyPerformance(session, range, model),
    dataQuality(session),
    // `declined` is a stage event but not a configured funnel stage, so it is
    // absent from the stage totals and has to be read from the buckets.
    windowBuckets(session, trailingMonths(today, 12), 'month', model),
    loadMetrics(session),
    submissionReport(session, range),
    maxRateLeakage(session),
    callReport(session, range, await alowareConnectedThreshold(session)),
    sourcesThrough(session),
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
   * Transitions the funnel must not put a rate on, from configuration.
   *
   * A blocked *metric* whose formula is a stage conversion rate names the two
   * stages it spans, so the same row that suppresses the KPI card suppresses
   * the connector chip between those stages. Otherwise blocking offer rate on
   * the executive screen would leave the identical figure on this one, which is
   * how a number survives being retired.
   */
  const suppressed = [...metrics.byKey.values()].flatMap((metric) => {
    const block = metrics.blocked(metric.key);
    if (!block || metric.formulaKey !== 'stage_conversion_rate') return [];
    const from = String(metric.formulaArgs.from ?? '');
    const to = String(metric.formulaArgs.to ?? '');
    if (!from || !to) return [];
    return [{ from, to, label: block.label, reason: block.reason }];
  });

  /**
   * Declines per month, for the timing.
   *
   * The series comes from the bucket query and the window total from
   * `data.declines`, because `declined` is deliberately not a funnel stage —
   * it is an outcome, not a step — so it never appears in `total.stages`. The
   * total is a distinct count over the whole window rather than a sum of these
   * bars: a deal declined in June and again in August is one deal in the
   * window and a bar in each month.
   */
  const declinePoints = buckets.map((b) => ({
    label: b.label,
    value: b.crmIngested ? (b.stages.declined ?? 0) : null,
    provisional: b.provisional,
  }));
  const declineReason = quality.find((q) => q.key === 'blocked:decline_reason_deal_grain') ?? null;

  const populations = [
    { key: 'all', label: 'All sources', counts: data.total.stages },
    ...data.channels.map((c) => ({ key: c.platform, label: c.label, counts: c.stages })),
    { key: 'unattributed', label: 'Unattributed', counts: data.unattributed.stages },
  ];
  const population = populations.find((p) => p.key === query.channel) ?? populations[0]!;

  const channelKeys = data.channels.map((c) => c.platform);
  const measurable = data.stages.filter((s) => !data.stageStatus[s.key]?.blocked);

  /**
   * The breakdown dimensions.
   *
   * Every one of them is blocked or unbuilt today, and the tabs render with the
   * reason on the panel rather than being hidden: a dimension that is absent
   * from the interface is a dimension nobody knows to ask for.
   */
  const dimensions = [
    { key: 'campaign', label: 'Campaign' },
    { key: 'industry', label: 'Industry' },
    { key: 'state', label: 'State' },
    { key: 'product', label: 'Product' },
  ];
  const dimension = dimensions.find((d) => d.key === query.dim) ?? dimensions[0]!;

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
    ...quality.map((item) => ({
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
    dim: dimension.key,
  });
  const active = {
    channel: population.key,
    model,
    dim: dimension.key,
    ...rangeParams(range),
  };

  return (
    <>
      <TopBar tenant={session.tenant} viewer={session.viewer} title="Funnel">
        <Segmented
          label="Population"
          active={population.key}
          options={segments(base, active, 'channel', populations)}
        />
        <Segmented
          label="Attribution model"
          active={model}
          options={segments(base, active, 'model', MODELS)}
        />
        <DateRangePicker
          range={range}
          preset={preset}
          presetHref={presetHref}
          preserve={preserve}
          problem={problem}
          earliest={earliest}
          today={today}
        />
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
              suppressed={suppressed}
              maxLeakage={leakageTolerance}
              gateFor={(denominator) => metrics.population('stage_conversion_rate', denominator)}
            />
          )}
        </Card>

        {callsOut ? (
          <NotMeasuredCard title="Call tracking" subtitle="Aloware" reason={callsWhy} />
        ) : (
          <CallTracking report={calls} span={12} />
        )}

        {/*
          The chart and the decline card share the left column rather than
          each taking their own grid row. Data quality is the taller card, so
          a decline card placed after it started a new row and left a void the
          height of the chart under the chart — which reads as a screen that
          failed to finish loading.
        */}
        <div className="col-span-12 flex flex-col gap-6 lg:col-span-8">
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
            subtitle="Unattributed is its own segment, never folded into a channel"
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
            points={declinePoints}
            total={data.declines.deals}
            events={data.declines.events}
            range={range}
            reason={declineReason}
            submissions={submissions}
          />
          </>
          )}
        </div>

        <DataQualityCard items={quality} span={4} />

        {crmOut ? (
          <NotMeasuredCard title="Lender outcomes" reason={crmWhy} />
        ) : (
          <LenderOutcomes
            report={submissions}
            span={12}
            gateFor={(decided) => metrics.population('submission_offer_rate', decided)}
          />
        )}

        <Card span={12}>
          <CardHeader
            title="Breakdown"
            subtitle={`${dimension.label} · ${population.label}`}
            controls={
              <Segmented
                label="Dimension"
                active={dimension.key}
                options={segments(base, active, 'dim', dimensions)}
              />
            }
          />
          {crmOut ? (
            <CardBody>
              <EmptyLine action={<NotMeasuredBadge />}>{crmWhy}</EmptyLine>
            </CardBody>
          ) : (
            <BreakdownPanel
              dimension={dimension}
              stages={measurable.map((s) => ({ key: s.key, label: s.label }))}
              counts={population.counts}
              slug={slug}
            />
          )}
        </Card>
      </Grid>

      <MethodNotesForPrint notes={notes} />
    </>
  );
}

/**
 * The breakdown table.
 *
 * Every dimension the brief asks for is either blocked in the CRM or waiting on
 * a connector, and the honest render is the stage columns with an explicit
 * blocked state for the slice — not a table of zeroes and not a hidden tab.
 * The one thing it can show today is the stage profile of the selected
 * population, which is the row that dimension would be sliced into.
 */
function BreakdownPanel({
  dimension,
  stages,
  counts,
  slug,
}: {
  dimension: { key: string; label: string };
  stages: { key: string; label: string }[];
  counts: Record<string, number>;
  slug: string;
}) {
  const REASONS: Record<string, string> = {
    campaign:
      'Campaign-level drill-down is Zeeraa build work and follows the monthly table. 3 of the 9 attributed deals carry a click that has aged out of the 90-day window, so their campaign is permanently unknown even once it lands.',
    industry:
      'Industry is not populated on inbound leads in Salesforce, so banding by it would produce one row of everything.',
    state:
      'State is present on some leads and absent on most; a slice would report the ones that happen to carry it as though they were the population.',
    product:
      'Product is not a field on the opportunity in this org. It would have to be derived from the record type, which is a decision rather than a query.',
  };

  const first = stages[0];
  const denominator = first ? (counts[first.key] ?? 0) : 0;

  return (
    <>
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
              <th scope="col" className="px-5 py-2.5 font-semibold">
                Reach
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border last:border-b-0">
              <th scope="row" className="px-5 py-3 text-left font-medium text-text">
                <span className="flex flex-wrap items-center gap-2">
                  All {dimension.label.toLowerCase()}s
                  <Badge tone="warn">Not measured</Badge>
                  <InfoTip label={`Why ${dimension.label} cannot be sliced`} align="start">
                    {REASONS[dimension.key]}
                  </InfoTip>
                </span>
              </th>
              {stages.map((stage) => (
                <td key={stage.key} className="numeric px-3 py-3 tabular text-text">
                  {formatCount(counts[stage.key] ?? 0)}
                </td>
              ))}
              <td className="px-5 py-3">
                <span className="flex items-center gap-2">
                  <Progress
                    value={1}
                    label={`Whole population, ${formatCount(denominator)} at the first measured stage`}
                  />
                  <span className="shrink-0 text-[12px] tabular text-text-2">
                    {formatRate(1)}
                  </span>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <CardBody className="pt-3">
        <EmptyLine href={`/${slug}/connections`} action="Connections">
          One row until {dimension.label.toLowerCase()} can be sliced.
        </EmptyLine>
      </CardBody>
    </>
  );
}
