import { Download } from 'lucide-react';
import { RampTable } from '@/components/RampTable';
import { buildRampPanels, rampTableRows } from '@/lib/ramp-panels';
import { AutoRefresh } from '@/components/shell/AutoRefresh';
import {
  addDays,
  formatTargetCurrency,
  canAdministerTenant,
  delta,
  formatCount,
  formatCurrency,
  formatRate,
  previousRange,
  tenantDay,
  trailingMonths,
  type AttributionModel,
  type DateRange,
} from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine, Grid } from '@/components/ui/Card';
import { ButtonLink } from '@/components/ui/Button';
import { segments } from '@/components/ui/Segmented';
import { AttributionModelToggle } from '@/components/AttributionModelToggle';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import {
  coverageFor,
  isUnmeasured,
  notMeasuredReason,
  sourceName,
  sourcesThrough,
  throughNote,
} from '@/lib/coverage';
import { rangeLinks, rangeParams, resolvePageRange } from '@/lib/range';
import { Delta, NoDelta } from '@/components/ui/Delta';
import { InfoTip } from '@/components/ui/InfoTip';
import { NotMeasuredBadge, ProvisionalHint } from '@/components/ui/Badge';
import { MethodDrawer, MethodNotesForPrint, type MethodNote } from '@/components/ui/Drawer';
import { PageMeta, TopBar } from '@/components/shell/TopBar';
import { PrintButton, SyncNowButton } from '@/components/shell/actions';
import { KpiCard } from '@/components/KpiCard';
import { LenderOfferRateCard } from '@/components/LenderOfferRateCard';
import { PerformanceTable } from '@/components/PerformanceTable';
import { CostPerDealCoverage } from '@/components/CostPerDeal';
import { AreaSeries } from '@/components/charts/AreaSeries';
import { DivergingBars, RangeBars, StackedBars } from '@/components/charts/Bars';
import { formatter } from '@/components/charts/format-spec';
import { monthlyPerformance, platformLabel, submissionReport } from '@/lib/reporting';
import {
  covers,
  engagementRamp,
  frozenBaseline,
  dataQuality,
  firstSentence,
  ingestionStart,
  loadMetrics,
  windowBuckets,
  type WindowBucket,
} from '@/lib/dashboard';
import { requireTenant } from '@/lib/tenant';
import { DataQualityCard } from '@/components/DataQualityCard';

export const metadata = { title: 'Monthly performance' };

const MODELS = [
  { key: 'last_touch', label: 'Last touch' },
  { key: 'first_touch', label: 'First touch' },
];




/**
 * The workhorse reporting screen.
 *
 * One row per channel, an explicit unattributed row group that is not a
 * channel, and a totals row that renders nothing where a total would be a
 * category error. See `docs/brief-amendments.md`, "§9.2 and §12 — the
 * separation rule is a layout rule too".
 */
export default async function Performance({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{
    model?: string;
    from?: string;
    to?: string;
    preset?: string;
    /** Read only so a link made before the date picker existed still works. */
    days?: string;
  }>;
}) {
  const { tenant: slug } = await params;
  const query = await searchParams;
  const session = await requireTenant(slug);

  const model: AttributionModel = query.model === 'first_touch' ? 'first_touch' : 'last_touch';

  const page = await resolvePageRange(session, query);
  const { today, earliest, ingestion, problem } = page;

  /**
   * The picked range, and nothing else: one date control on the page. The
   * month selector ("Trailing window") and the "Previous period / Last year"
   * toggle were removed on 24 September 2026 — a client read the selector as a
   * second date range, and a figure is always compared with the period of the
   * same length immediately before.
   */
  const range: DateRange = page.range;
  const preset = page.preset;
  const baseline: DateRange = previousRange(range);

  const currency = session.tenant.currency;

  const [
    data,
    previous,
    buckets,
    metrics,
    quality,
    submissions,
    through,
    ramp,
    frozen,
  ] = await Promise.all([
    monthlyPerformance(session, range, model),
    monthlyPerformance(session, baseline, model),
    windowBuckets(session, trailingMonths(today, 12), 'month', model),
    loadMetrics(session),
    dataQuality(session),
    submissionReport(session, range),
    sourcesThrough(session),
    engagementRamp(session),
    frozenBaseline(session),
  ]);

  /*
   * No zeros for a range past a source's last read. Each figure asks the
   * source behind it; `Not measured` replaces the figure, and a comparison
   * against an unread baseline has no delta. See `lib/coverage.ts`.
   */
  const cover = coverageFor(through, range);
  const spendOut = isUnmeasured(cover.spend);
  const crmOut = isUnmeasured(cover.crm);
  const spendBaseOut = isUnmeasured(cover.of(through.spendPlatforms, baseline));
  const crmBaseOut = isUnmeasured(cover.of('salesforce', baseline));
  const spendWhy = notMeasuredReason(cover.spend, sourceName(through.spendPlatforms));
  const crmWhy = notMeasuredReason(cover.crm, 'Salesforce');
  const coverageNote =
    throughNote(cover.spend, 'paid media') + throughNote(cover.crm, 'Salesforce');

  // Paid media was first pulled long after the CRM history begins, so the two
  // have separate baselines. See `ingestionStart`. A baseline past the last
  // read is no baseline either.
  //
  // The KPI cards share one start: the first day of paid media. The CRM's own
  // history reaches back to 2024, but the funded deals in it thin out to one
  // a month before paid media began, so a previous period reaching before
  // that compared 22 deals with 2 and printed +1,000% (24 September 2026). A
  // previous period that starts before the data does is not shown at all —
  // no delta, and no line explaining the absence.
  const dataStart = ingestion.spendFrom;
  const spendComparable = covers(dataStart, baseline) && !spendBaseOut;
  const crmComparable = covers(dataStart, baseline) && !crmBaseOut;

  const channelKeys = data.channels.map((c) => c.platform);
  const valueStage = data.stages.find((s) => s.countsValue);
  const valueKey = valueStage?.key ?? null;
  const valueLabel = valueStage?.label ?? 'Funded';
  const dealsIn = (stages: Record<string, number>) => (valueKey ? (stages[valueKey] ?? 0) : 0);

  const lead = [...data.channels].sort((a, b) => b.spend - a.spend)[0] ?? null;
  const leadPrevious = lead
    ? (previous.channels.find((c) => c.platform === lead.platform) ?? null)
    : null;

  /**
   * The lender offer rate's configuration row.
   *
   * `offer_rate` itself is gone from this screen: it is retired by a `metric`
   * block, which the data quality card renders, and the figure that answers the
   * same question lives at lender grain. The helpers that computed the old
   * deal-level rate were removed with it rather than left behind dark, because
   * a dead rate is one import away from coming back.
   */
  const lenderOfferMetric = metrics.byKey.get('lender_offer_rate');

  // The mini charts start at the month the data does: a bucket before it is
  // not drawn at all, rather than as an empty bar or a zero.
  const miniBuckets = dataStart ? buckets.filter((b) => b.end >= dataStart) : buckets;
  const mini = (
    pick: (bucket: WindowBucket) => number | null,
    source: 'spend' | 'crm' = 'crm',
  ) =>
    miniBuckets.map((bucket) => ({
      label: bucket.label,
      value: (source === 'spend' ? bucket.spendIngested : bucket.crmIngested)
        ? pick(bucket)
        : null,
      provisional: bucket.provisional,
    }));

  const money = formatter({ kind: 'currency', currency });
  const channelLabels = Object.fromEntries(channelKeys.map((c) => [c, platformLabel(c)]));

  /**
   * Month over month, as a percentage, one bar per metric.
   *
   * The two months are the last *complete* ones, not the current month against
   * the one before it: today is the 18th, and comparing eighteen days to
   * thirty-one reports a collapse in every volume metric that has not happened.
   *
   * Percentages rather than absolutes because five metrics in four units cannot
   * share an axis, and the point of the form is the baseline. Colour comes from
   * each metric's own `improvement_direction` — cost per deal falling is an
   * improvement and funded volume falling is not, and a chart that coloured
   * both the same would be lying about one of them. A metric configuration
   * gives no direction for, like paid media spend, stays blue.
   */
  // A cost always shows its number with what it was based on — no minimum
  // deal count (see `packages/core/src/population.ts`). It compares with the
  // previous period whenever that period had a deal to divide by.
  const leadBaselineComparable = (leadPrevious?.costPerDeal.attributedDeals ?? 0) > 0;

  const complete = buckets.filter((bucket) => bucket.end < `${today.slice(0, 7)}-01`);
  const thisMonth = complete.at(-1) ?? null;
  const lastMonth = complete.at(-2) ?? null;

  const monthOverMonth =
    thisMonth && lastMonth
      ? (
          [
            {
              key: 'paid_media_spend',
              label: 'Paid media spend',
              source: 'spend' as const,
              of: (b: WindowBucket) => b.spend,
            },
            {
              key: 'funded_deals',
              label: `${valueLabel} deals`,
              source: 'crm' as const,
              of: (b: WindowBucket) => (valueKey ? (b.stages[valueKey] ?? 0) : 0),
            },
            {
              key: 'funded_volume',
              label: `${valueLabel} volume`,
              source: 'crm' as const,
              of: (b: WindowBucket) => b.valueVolume,
            },
            {
              key: 'applications',
              label: 'Applications',
              source: 'crm' as const,
              of: (b: WindowBucket) => b.stages.application ?? 0,
            },
            ...(lead
              ? [
                  {
                    key: 'cost_per_funded_deal',
                    label: `Cost per deal · ${lead.label}`,
                    source: 'spend' as const,
                    // The channel's own deals: the denominator the comparison
                    // is gated on, and never a zero standing in for "no deals".
                    denominator: (b: WindowBucket) =>
                      valueKey ? (b.stagesByPlatform[lead.platform]?.[valueKey] ?? 0) : 0,
                    of: (b: WindowBucket): number | null => {
                      const deals = valueKey
                        ? (b.stagesByPlatform[lead.platform]?.[valueKey] ?? 0)
                        : 0;
                      return deals === 0 ? null : (b.spendByPlatform[lead.platform] ?? 0) / deals;
                    },
                  },
                ]
              : []),
          ]
            .map((row: {
              key: string;
              label: string;
              source: 'spend' | 'crm';
              of: (b: WindowBucket) => number | null;
              denominator?: (b: WindowBucket) => number;
            }) => {
              const ingested = (b: WindowBucket) =>
                row.source === 'spend' ? b.spendIngested : b.crmIngested;
              if (!ingested(thisMonth) || !ingested(lastMonth)) return null;
              // A month with no attributed deal has no cost per deal, and used
              // to plot as 0 — a green −100% about nothing.
              if (row.denominator && (row.denominator(thisMonth) === 0 || row.denominator(lastMonth) === 0)) {
                return null;
              }
              const current = row.of(thisMonth);
              const base = row.of(lastMonth);
              if (current === null || base === null || base === 0) return null;
              const direction = metrics.direction(row.key);
              const d = delta(current, base, direction ?? 'up');
              return {
                label: row.label,
                value: (d.relative ?? 0) * 100,
                assessment: direction === null ? ('level' as const) : d.assessment,
              };
            })
            .filter((row): row is NonNullable<typeof row> => row !== null)
        )
      : [];

  const notes: MethodNote[] = [
    {
      heading: 'Totals',
      body:
        'Spend adds across channels and deals add across every source. Cost per deal does not ' +
        'add, and dividing one total by the other is a different metric.',
      detail: data.total.costPerDealAbsentBecause,
    },
    { heading: 'Deals no channel can claim', body: data.unattributed.reason },
    {
      heading: 'Cost per deal by channel',
      body:
        'Each bar is the range the data supports, not a single figure. The marker at the right ' +
        'is the confirmed cost per deal — that channel’s spend over the deals attributed to it. ' +
        'The soft end is where it would land if every unattributed deal turned out to be that ' +
        'channel’s.',
    },
    {
      heading: 'Change against the comparison period',
      body:
        'Percentages, so five metrics in four units can share one axis. Green and red come from ' +
        'each metric’s improvement direction, never from the direction of travel.',
      detail:
        'Paid media spend has no configured direction and stays blue: spending less is not an ' +
        'achievement and spending more is not a failure — what it bought decides that.',
    },
    ...(canAdministerTenant(session.tenant.role) ? quality : []).map((item) => ({
      heading: item.name,
      body: item.detail || item.summary,
      detail: item.since
        ? `Outstanding since ${item.since.toISOString().slice(0, 10)}.`
        : undefined,
    })),
  ];

  const base = `/${slug}/performance`;
  const { preserve, presetHref } = rangeLinks(base, { model });
  const active = { model, ...rangeParams(range) };

  const provisional = range.end >= addDays(today, -6);

  return (
    <>
      <TopBar
        tenant={session.tenant}
        viewer={session.viewer}
        title="Monthly performance"
      >
        <DateRangePicker
          range={range}
          preset={preset}
          presetHref={presetHref}
          preserve={preserve}
          problem={problem}
          earliest={earliest}
          today={today}
        />
        <AttributionModelToggle active={model} options={segments(base, active, 'model', MODELS)} />
        <ButtonLink
          data-tour="export-csv"
          href={`/api/export/${slug}/performance?${new URLSearchParams({ model, ...rangeParams(range) }).toString()}`}
        >
          <Download aria-hidden="true" className="h-4 w-4" />
          Export CSV
        </ButtonLink>
        <PrintButton />
        {canAdministerTenant(session.tenant.role) && (
          <SyncNowButton slug={slug} platform="google_ads" />
        )}
      </TopBar>

      <PageMeta>
        <AutoRefresh />
        <MethodDrawer
          notes={notes}
          title={`${range.start} to ${range.end} · ${session.tenant.timezone}`}
        />
      </PageMeta>

      <Grid>
        <KpiCard
          label="Paid media spend"
          value={spendOut ? null : formatCurrency(data.total.spend, currency)}
          notMeasured={spendWhy}
          delta={
            spendComparable ? (
              <Delta
                current={data.total.spend}
                baseline={previous.total.spend}
                direction={metrics.direction('paid_media_spend')}
                comparison="vs previous period"
              />
            ) : undefined
          }
          context={`${range.start} to ${range.end}${throughNote(cover.spend, 'paid media')}`}
          points={mini((b) => b.spend, 'spend')}
          provisional={provisional}
          info="Spend across every connected channel. No metric declares a direction for it, so its change carries a sign and an arrow and no colour."
        />

        <KpiCard
          label={`${valueLabel} deals`}
          value={crmOut ? null : formatCount(dealsIn(data.total.stages))}
          notMeasured={crmWhy}
          delta={
            crmComparable ? (
              <Delta
                current={dealsIn(data.total.stages)}
                baseline={dealsIn(previous.total.stages)}
                direction={metrics.direction('funded_deals')}
                comparison="vs previous period"
              />
            ) : undefined
          }
          context={
            crmOut
              ? undefined
              : `${formatCount(
                  data.channels.reduce((sum, c) => sum + dealsIn(c.stages), 0),
                )} with a source · ${formatCount(dealsIn(data.unattributed.stages))} unattributed${throughNote(
                  cover.crm,
                  'Salesforce',
                )}`
          }
          points={mini((b) => (valueKey ? (b.stages[valueKey] ?? 0) : null))}
          variant="bars"
          provisional={provisional}
          info="Deals reaching the value stage in the period, from every source. Only the attributed ones enter a channel's denominator."
        />

        {lead ? (
          <KpiCard
            label={`Cost per ${valueLabel.toLowerCase()} deal · ${lead.label}`}
            value={
              spendOut || crmOut || lead.costPerDeal.value === null
                ? null
                : formatCurrency(lead.costPerDeal.value, currency)
            }
            notMeasured={
              crmOut
                ? crmWhy
                : spendOut
                  ? spendWhy
                  : lead.costPerDeal.value === null
                    ? 'No deals yet'
                    : undefined
            }
            delta={
              !spendOut && !crmOut && lead.costPerDeal.value !== null ? (
                spendComparable ? (
                  <Delta
                    current={lead.costPerDeal.value}
                    baseline={leadBaselineComparable ? (leadPrevious?.costPerDeal.value ?? null) : null}
                    direction={metrics.direction('cost_per_funded_deal')}
                    comparison="vs previous period"
                    unavailable="no deals in the previous period"
                  />
                ) : undefined
              ) : (
                <NoDelta />
              )
            }
            context={
              spendOut || crmOut ? undefined : (
              <CostPerDealCoverage
                cost={lead.costPerDeal}
                currency={currency}
                channelLabel={lead.label}
              />
              )
            }
            points={mini((b) => {
              if (!valueKey) return null;
              const deals = b.stagesByPlatform[lead.platform]?.[valueKey] ?? 0;
              // A month with no attributed deal has no cost per deal, and
              // is a gap in the line rather than a zero.
              if (deals === 0) return null;
              return (b.spendByPlatform[lead.platform] ?? 0) / deals;
            }, 'spend')}
            provisional={provisional}
            info="One channel's spend over the deals attributed to that channel. A blended figure across every channel has a different denominator and is not computable until every channel is ingested."
          />
        ) : (
          <Card span={3}>
            <CardHeader title={`Cost per ${valueLabel.toLowerCase()} deal`} />
            <CardBody>
              <EmptyLine>No channel has reported spend in this window.</EmptyLine>
            </CardBody>
          </Card>
        )}

        {/*
          Offer rate, replaced rather than merely blocked.
          The deal-level metric is retired — a `metric` row in
          `blocked_dependencies` records why, and it still renders in the data
          quality card. What stands in its place is the same question asked at
          the grain the answer exists: one lender's offers over that lender's
          decisions.
        */}
        <LenderOfferRateCard
          report={submissions}
          metric={lenderOfferMetric}
          unsynced={crmOut ? crmWhy : undefined}
          gate={metrics.population('submission_offer_rate', submissions.overall.decided)}
        />

        {/*
          The ramp as one month-by-month table (24 September 2026): spend,
          approvals, CPA, funded deals and cost per funded deal, each against
          its target. Same months and the same verdict rule as the executive
          scorecard (`lib/ramp-panels.ts`).
        */}
        {(() => {
          const panels = buildRampPanels({
            buckets,
            metrics,
            ramp,
            frozen,
            through,
            valueKey,
            valueLabel,
            currency,
            currentMonth: today.slice(0, 7),
          });
          if (panels.startMonth === null) return null;
          const [y, m, d] = today.split('-').map(Number);
          const elapsed = d! / new Date(Date.UTC(y!, m!, 0)).getUTCDate();
          const every = [panels.primary, panels.secondary, ...panels.compact];
          const formats = Object.fromEntries(every.map((p) => [p.metric, p.format])) as Record<
            (typeof every)[number]['metric'],
            (typeof every)[number]['format']
          >;
          return (
            <RampTable
              channel={panels.channel}
              rows={rampTableRows(panels, { currentMonth: today.slice(0, 7), elapsed })}
              formats={formats}
              valueLabel={valueLabel}
            />
          );
        })()}

        <Card span={8}>
          <CardHeader
            title="Spend over time"
            subtitle="Every connected channel, by month"
            controls={buckets.at(-1)?.provisional ? <ProvisionalHint /> : undefined}
            info={
              <InfoTip label="How the spend series is built" align="start">
                Months before ingestion began are blank rather than zero: nobody looked, so the
                spend was not measured to be nothing.
              </InfoTip>
            }
          />
          <CardBody className="flex-1 px-2">
            <AreaSeries
              id="perf-spend"
              points={mini((b) => b.spend, 'spend')}
              format={{ kind: 'currency', currency }}
              height={260}
            />
          </CardBody>
        </Card>

        <Card span={4}>
          <CardHeader
            title={`${valueLabel} deals by channel`}
            subtitle="Unattributed is its own segment"
          />
          <CardBody className="flex-1">
            <StackedBars
              id="perf-deals-by-channel"
              rows={buckets
                .filter((b) => b.crmIngested)
                .map((b) => ({
                  label: b.label,
                  byChannel: Object.fromEntries(
                    channelKeys.map((c) => [c, valueKey ? (b.stagesByPlatform[c]?.[valueKey] ?? 0) : 0]),
                  ),
                  unattributed: valueKey ? (b.unattributedStages[valueKey] ?? 0) : 0,
                }))}
              channels={channelKeys}
              channelLabels={channelLabels}
              format={{ kind: 'count' }}
              height={240}
            />
          </CardBody>
        </Card>

        <Card span={12} dataTour="performance-table">
          <CardHeader
            title="All platforms"
            subtitle={`${range.start} to ${range.end} · ${
              model === 'last_touch' ? 'last touch' : 'first touch'
            } · ${session.tenant.timezone}${coverageNote}`}
            controls={
              data.dataThrough ? (
                <span className="text-[12px] text-text-3 tabular">
                  Data through {data.dataThrough.toISOString().slice(0, 16).replace('T', ' ')} UTC
                </span>
              ) : (
                <span className="text-[12px] text-text-3">No completed sync</span>
              )
            }
          />
          {spendOut || crmOut ? (
            <CardBody>
              <EmptyLine action={<NotMeasuredBadge />}>{crmOut ? crmWhy : spendWhy}</EmptyLine>
            </CardBody>
          ) : data.channels.length > 0 || dealsIn(data.total.stages) > 0 ? (
            <PerformanceTable data={data} currency={currency} />
          ) : (
            <CardBody>
              <EmptyLine href={`/${slug}/connections`} action="Check connections">
                No platform has reported in this window.
              </EmptyLine>
            </CardBody>
          )}
        </Card>

        <Card span={6}>
          <CardHeader
            title={`Cost per ${valueLabel.toLowerCase()} deal by channel`}
            subtitle="The marker is confirmed; the bar is the range the data supports"
          />
          <CardBody className="flex-1">
            {spendOut || crmOut ? (
              <EmptyLine action={<NotMeasuredBadge />}>{crmOut ? crmWhy : spendWhy}</EmptyLine>
            ) : (
            <RangeBars
              id="perf-cost-range"
              rows={data.channels
                .filter((c) => c.costPerDeal.value !== null)
                .map((c) => ({
                  label: c.label,
                  platform: c.platform,
                  confirmed: c.costPerDeal.value!,
                  low: c.costPerDeal.plausibleRange.low ?? c.costPerDeal.value!,
                  attributedDeals: c.costPerDeal.attributedDeals,
                  unattributedDeals: c.costPerDeal.unattributedDeals,
                }))}
              format={{ kind: 'currency', currency }}
              target={
                metrics.target('cost_per_funded_deal') !== null
                  ? {
                      value: metrics.target('cost_per_funded_deal')!,
                      label: `Target ${formatTargetCurrency(metrics.target('cost_per_funded_deal')!, currency)}`,
                    }
                  : null
              }
              height={240}
            />
            )}
          </CardBody>
        </Card>

        <Card span={6}>
          <CardHeader
            title="Stage composition"
            subtitle="Blocked stages are absent rather than drawn at zero"
          />
          <CardBody className="flex-1">
            {crmOut ? (
              <EmptyLine action={<NotMeasuredBadge />}>{crmWhy}</EmptyLine>
            ) : (
            <StackedBars
              id="perf-stage-composition"
              layout="horizontal-bars"
              rows={data.stages
                .filter((stage) => !data.stageStatus[stage.key]?.blocked)
                .map((stage) => ({
                  label: stage.label,
                  byChannel: Object.fromEntries(
                    data.channels.map((c) => [c.platform, c.stages[stage.key] ?? 0]),
                  ),
                  unattributed: data.unattributed.stages[stage.key] ?? 0,
                }))}
              channels={channelKeys}
              channelLabels={channelLabels}
              format={{ kind: 'count' }}
              height={240}
            />
            )}
          </CardBody>
        </Card>

        {/* Full width for a client, who has no data-quality card beside it. */}
        <Card span={canAdministerTenant(session.tenant.role) ? 8 : 12} selfStart>
          <CardHeader
            title="Month over month"
            subtitle={
              thisMonth && lastMonth
                ? `${monthName(lastMonth.key)} → ${monthName(thisMonth.key)} · the last two complete months`
                : 'Two complete months are needed'
            }
            info={
              <InfoTip label="How this comparison is built" align="start">
                Percentage change, so metrics in different units share one axis. Green and red come
                from each metric&rsquo;s improvement direction, never from the direction of travel.
              </InfoTip>
            }
          />
          <CardBody className="flex-1">
            <DivergingBars
              id="perf-change"
              rows={monthOverMonth}
              format={{ kind: 'percentPoints' }}
              height={260}
            />
          </CardBody>
        </Card>

        {canAdministerTenant(session.tenant.role) && <DataQualityCard items={quality} span={4} />}
      </Grid>

      <MethodNotesForPrint notes={notes} />
    </>
  );
}



function monthName(key: string): string {
  return new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

