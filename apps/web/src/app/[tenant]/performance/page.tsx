import { Download } from 'lucide-react';
import {
  addDays,
  canAdministerTenant,
  delta,
  formatCount,
  formatCurrency,
  formatRate,
  monthRange,
  previousMonth,
  previousRange,
  tenantDay,
  trailingMonths,
  trailingWindow,
  type AttributionModel,
  type DateRange,
} from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine, Grid } from '@/components/ui/Card';
import { ButtonLink } from '@/components/ui/Button';
import { Segmented, segments } from '@/components/ui/Segmented';
import { Delta, NoDelta } from '@/components/ui/Delta';
import { InfoTip } from '@/components/ui/InfoTip';
import { ProvisionalBadge } from '@/components/ui/Badge';
import { MethodDrawer, MethodNotesForPrint, type MethodNote } from '@/components/ui/Drawer';
import { PageMeta, TopBar } from '@/components/shell/TopBar';
import { PrintButton, SyncNowButton } from '@/components/shell/actions';
import { KpiCard } from '@/components/KpiCard';
import { PerformanceTable } from '@/components/PerformanceTable';
import { CostPerDealCoverage } from '@/components/CostPerDeal';
import { AreaSeries } from '@/components/charts/AreaSeries';
import { DivergingBars, RangeBars, StackedBars } from '@/components/charts/Bars';
import { formatter } from '@/components/charts/format-spec';
import { MonthSelect } from '@/components/MonthSelect';
import { monthlyPerformance, platformLabel } from '@/lib/reporting';
import {
  covers,
  dataQuality,
  ingestionStart,
  loadMetrics,
  minRateDenominator,
  unreadNotifications,
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

const WINDOWS = [
  { key: '30', label: '30d' },
  { key: '90', label: '90d' },
  { key: '365', label: '365d' },
];

const COMPARE = [
  { key: 'previous', label: 'Previous period' },
  { key: 'year', label: 'Last year' },
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
  searchParams: Promise<{ model?: string; days?: string; month?: string; compare?: string }>;
}) {
  const { tenant: slug } = await params;
  const query = await searchParams;
  const session = await requireTenant(slug);

  const model: AttributionModel = query.model === 'first_touch' ? 'first_touch' : 'last_touch';
  const days = WINDOWS.some((w) => w.key === query.days) ? Number(query.days) : 90;
  const compare = COMPARE.some((c) => c.key === query.compare) ? query.compare! : 'previous';

  const today = tenantDay(new Date(), session.tenant.timezone);
  const monthPick = /^\d{4}-\d{2}$/.test(query.month ?? '') ? query.month! : null;

  // A named month or a trailing window. One range drives every figure on the
  // screen, so nothing here can be reading a different period from its neighbour.
  const range: DateRange = monthPick
    ? clip(monthRange(monthPick), today)
    : trailingWindow(today, days);

  const baseline: DateRange =
    compare === 'year' ? shiftYear(range) : monthPick ? clip(monthRange(previousMonth(monthPick)), today) : previousRange(range);

  const currency = session.tenant.currency;

  const [data, previous, buckets, metrics, quality, unread, ingestion, rateFloor] =
    await Promise.all([
    monthlyPerformance(session, range, model),
    monthlyPerformance(session, baseline, model),
    windowBuckets(session, trailingMonths(today, 12), 'month', model),
    loadMetrics(session),
    dataQuality(session),
    unreadNotifications(session),
    ingestionStart(session),
    minRateDenominator(session),
  ]);

  // Paid media was first pulled long after the CRM history begins, so the two
  // have separate baselines. See `ingestionStart`.
  const spendComparable = covers(ingestion.spendFrom, baseline);
  const crmComparable = covers(ingestion.crmFrom, baseline);
  const notIngested = (from: string | null) =>
    from ? `not ingested before ${from}` : 'nothing ingested yet';

  const channelKeys = data.channels.map((c) => c.platform);
  const valueStage = data.stages.find((s) => s.countsValue);
  const valueKey = valueStage?.key ?? null;
  const valueLabel = valueStage?.label ?? 'Funded';
  const dealsIn = (stages: Record<string, number>) => (valueKey ? (stages[valueKey] ?? 0) : 0);

  const lead = [...data.channels].sort((a, b) => b.spend - a.spend)[0] ?? null;
  const leadPrevious = lead
    ? (previous.channels.find((c) => c.platform === lead.platform) ?? null)
    : null;

  const offerMetric = metrics.byKey.get('offer_rate');
  const offerFrom = String(offerMetric?.formulaArgs.from ?? '');
  const offerTo = String(offerMetric?.formulaArgs.to ?? '');
  const offerBlocked =
    data.stageStatus[offerFrom]?.blocked ?? data.stageStatus[offerTo]?.blocked ?? null;
  const offerRate = (source: typeof data) => {
    const denominator = source.total.stages[offerFrom] ?? 0;
    return denominator === 0 ? null : (source.total.stages[offerTo] ?? 0) / denominator;
  };
  /**
   * Whether the comparison period can carry a rate at all.
   *
   * Not whether it has one — it does — but whether it has enough behind it to
   * compare against. The baseline here held one approval, so its offer rate was
   * 200% and the delta read as a 70% collapse caused by a single opportunity.
   */
  const offerBaseline = previous.total.stages[offerFrom] ?? 0;
  const offerComparable = offerBaseline >= rateFloor;

  const mini = (
    pick: (bucket: WindowBucket) => number | null,
    source: 'spend' | 'crm' = 'crm',
  ) =>
    buckets.map((bucket) => ({
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
                    of: (b: WindowBucket) => {
                      const deals = valueKey
                        ? (b.stagesByPlatform[lead.platform]?.[valueKey] ?? 0)
                        : 0;
                      return deals === 0 ? 0 : (b.spendByPlatform[lead.platform] ?? 0) / deals;
                    },
                  },
                ]
              : []),
          ]
            .map((row) => {
              const ingested = (b: WindowBucket) =>
                row.source === 'spend' ? b.spendIngested : b.crmIngested;
              if (!ingested(thisMonth) || !ingested(lastMonth)) return null;
              const current = row.of(thisMonth);
              const base = row.of(lastMonth);
              if (base === 0) return null;
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
    ...quality.map((item) => ({
      heading: item.name,
      body: item.detail || item.summary,
      detail: item.since
        ? `Outstanding since ${item.since.toISOString().slice(0, 10)}.`
        : undefined,
    })),
  ];

  const base = `/${slug}/performance`;
  const active = {
    model,
    days: String(days),
    compare,
    ...(monthPick ? { month: monthPick } : {}),
  };

  const monthOptions = lastMonths(today, 12);
  const provisional = range.end >= addDays(today, -6);

  return (
    <>
      <TopBar
        tenant={session.tenant}
        viewer={session.viewer}
        title="Monthly performance"
        unread={unread}
      >
        <MonthSelect base={base} params={active} months={monthOptions} active={monthPick} />
        {!monthPick && (
          <Segmented
            label="Window"
            active={String(days)}
            options={segments(base, active, 'days', WINDOWS)}
          />
        )}
        <Segmented
          label="Attribution model"
          active={model}
          options={segments(base, active, 'model', MODELS)}
        />
        <ButtonLink href={`/api/export/${slug}/performance?model=${model}&days=${days}`}>
          <Download aria-hidden="true" className="h-4 w-4" />
          Export CSV
        </ButtonLink>
        <PrintButton />
        {canAdministerTenant(session.tenant.role) && (
          <SyncNowButton slug={slug} platform="google_ads" />
        )}
      </TopBar>

      <PageMeta>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-[13px] text-text-2">Deltas compare against</span>
          <Segmented
            label="Compare against"
            active={compare}
            options={segments(base, active, 'compare', COMPARE)}
          />
        </div>
        <MethodDrawer
          notes={notes}
          title={`${range.start} to ${range.end} · ${session.tenant.timezone}`}
        />
      </PageMeta>

      <Grid>
        <KpiCard
          label="Paid media spend"
          value={formatCurrency(data.total.spend, currency)}
          delta={
            <Delta
              current={data.total.spend}
              baseline={spendComparable ? previous.total.spend : null}
              direction={metrics.direction('paid_media_spend')}
              comparison={compare === 'year' ? 'vs last year' : 'vs previous period'}
              unavailable={notIngested(ingestion.spendFrom)}
            />
          }
          context={`${range.start} to ${range.end}`}
          points={mini((b) => b.spend, 'spend')}
          provisional={provisional}
          info="Spend across every connected channel. No metric declares a direction for it, so its change carries a sign and an arrow and no colour."
        />

        <KpiCard
          label={`${valueLabel} deals`}
          value={formatCount(dealsIn(data.total.stages))}
          delta={
            <Delta
              current={dealsIn(data.total.stages)}
              baseline={crmComparable ? dealsIn(previous.total.stages) : null}
              direction={metrics.direction('funded_deals')}
              comparison={compare === 'year' ? 'vs last year' : 'vs previous period'}
              unavailable={notIngested(ingestion.crmFrom)}
            />
          }
          context={`${formatCount(
            data.channels.reduce((sum, c) => sum + dealsIn(c.stages), 0),
          )} attributed · ${formatCount(dealsIn(data.unattributed.stages))} to no channel`}
          points={mini((b) => (valueKey ? (b.stages[valueKey] ?? 0) : null))}
          variant="bars"
          provisional={provisional}
          info="Deals reaching the value stage in the period, from every source. Only the attributed ones enter a channel's denominator."
        />

        {lead ? (
          <KpiCard
            label={`Cost per ${valueLabel.toLowerCase()} deal · ${lead.label}`}
            value={
              lead.costPerDeal.value === null ? null : formatCurrency(lead.costPerDeal.value, currency)
            }
            notMeasured={`No ${valueLabel.toLowerCase()} deal is attributed to ${lead.label}`}
            delta={
              lead.costPerDeal.value !== null ? (
                <Delta
                  current={lead.costPerDeal.value}
                  baseline={
                    spendComparable ? (leadPrevious?.costPerDeal.value ?? null) : null
                  }
                  direction={metrics.direction('cost_per_funded_deal')}
                  comparison={compare === 'year' ? 'vs last year' : 'vs previous period'}
                  unavailable={notIngested(ingestion.spendFrom)}
                />
              ) : (
                <NoDelta />
              )
            }
            context={
              <CostPerDealCoverage
                cost={lead.costPerDeal}
                currency={currency}
                channelLabel={lead.label}
              />
            }
            points={mini((b) => {
              if (!valueKey) return null;
              const deals = b.stagesByPlatform[lead.platform]?.[valueKey] ?? 0;
              return deals === 0 ? null : (b.spendByPlatform[lead.platform] ?? 0) / deals;
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

        <KpiCard
          label={offerMetric?.label ?? 'Offer rate'}
          value={offerBlocked || offerRate(data) === null ? null : formatRate(offerRate(data)!)}
          notMeasured={
            offerBlocked
              ? `${offerBlocked.label} has no timestamp in the CRM`
              : 'Nothing reached the earlier stage in this window'
          }
          delta={
            !offerBlocked && offerRate(data) !== null ? (
              <Delta
                current={offerRate(data)!}
                baseline={crmComparable && offerComparable ? offerRate(previous) : null}
                direction={metrics.direction('offer_rate')}
                comparison={compare === 'year' ? 'vs last year' : 'vs previous period'}
                unavailable={
                  crmComparable
                    ? `previous period had only ${formatCount(offerBaseline)} to divide by`
                    : notIngested(ingestion.crmFrom)
                }
              />
            ) : (
              <NoDelta />
            )
          }
          context={
            offerBlocked
              ? undefined
              : `${formatCount(data.total.stages[offerTo] ?? 0)} of ${formatCount(
                  data.total.stages[offerFrom] ?? 0,
                )}`
          }
          points={mini((b) => {
            if (offerBlocked) return null;
            const denominator = b.stages[offerFrom] ?? 0;
            return denominator === 0 ? null : (b.stages[offerTo] ?? 0) / denominator;
          })}
          info={
            offerBlocked
              ? `${offerBlocked.reason}${offerBlocked.needed ? ` Needed: ${offerBlocked.needed}` : ''}`
              : (offerMetric?.definition ??
                'One instance of the generic stage conversion rate over the configured stages.')
          }
        />

        <Card span={8}>
          <CardHeader
            title="Spend over time"
            subtitle="Every connected channel, by month"
            controls={buckets.at(-1)?.provisional ? <ProvisionalBadge /> : undefined}
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

        <Card span={12}>
          <CardHeader
            title="All platforms"
            subtitle={`${range.start} to ${range.end} · ${
              model === 'last_touch' ? 'last touch' : 'first touch'
            } · ${session.tenant.timezone}`}
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
          {data.channels.length > 0 || dealsIn(data.total.stages) > 0 ? (
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
                      label: `Target ${money(metrics.target('cost_per_funded_deal')!)}`,
                    }
                  : null
              }
              height={240}
            />
          </CardBody>
        </Card>

        <Card span={6}>
          <CardHeader
            title="Stage composition"
            subtitle="Blocked stages are absent rather than drawn at zero"
          />
          <CardBody className="flex-1">
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
          </CardBody>
        </Card>

        <Card span={8} selfStart>
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

        <DataQualityCard items={quality} span={4} />
      </Grid>

      <MethodNotesForPrint notes={notes} />
    </>
  );
}

/** A named month never runs past today: the rest of it has not happened. */
function clip(range: DateRange, today: string): DateRange {
  return { start: range.start, end: range.end < today ? range.end : today };
}

/** The same calendar window, twelve months earlier. */
function shiftYear(range: DateRange): DateRange {
  const back = (day: string) => `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`;
  return { start: back(range.start), end: back(range.end) };
}

function monthName(key: string): string {
  return new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function lastMonths(today: string, count: number): { key: string; label: string }[] {
  const months: { key: string; label: string }[] = [];
  let key = today.slice(0, 7);
  for (let i = 0; i < count; i += 1) {
    months.push({
      key,
      label: new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }),
    });
    key = previousMonth(key);
  }
  return months;
}
