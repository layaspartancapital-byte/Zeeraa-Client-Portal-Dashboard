import {
  channelCostPerDeal,
  formatCount,
  formatCurrency,
  formatRate,
  previousRange,
  tenantDay,
  trailingMonths,
  trailingWindow,
  type AttributionModel,
} from '@zeeraa/core';
import { canAdministerTenant } from '@zeeraa/core';
import { Grid } from '@/components/ui/Card';
import { ButtonLink } from '@/components/ui/Button';
import { Segmented, segments } from '@/components/ui/Segmented';
import { Delta, NoDelta } from '@/components/ui/Delta';
import { MethodDrawer, MethodNotesForPrint, type MethodNote } from '@/components/ui/Drawer';
import { PageMeta, TopBar } from '@/components/shell/TopBar';
import { PrintButton, SyncNowButton } from '@/components/shell/actions';
import { KpiCard } from '@/components/KpiCard';
import { HeroCard, type SecondaryFigure } from '@/components/HeroCard';
import { DataQualityCard } from '@/components/DataQualityCard';
import { ChannelSnapshot } from '@/components/ChannelSnapshot';
import { coverageExplanation } from '@/components/CostPerDeal';
import { monthlyPerformance } from '@/lib/reporting';
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
import { Download } from 'lucide-react';

export async function generateMetadata({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const { tenant } = await requireTenant(slug);
  return { title: { absolute: `${tenant.name} · Executive` } };
}

const WINDOWS = [
  { key: '30', label: '30d' },
  { key: '90', label: '90d' },
  { key: '365', label: '365d' },
];

/**
 * The hero chart's own length, in months.
 *
 * Separate from the page's date range, and in months rather than days, because
 * the north star is a ratio with one or two funded deals in its numerator each
 * month: bucketed by week it is a line that is mostly gaps, and a 30-day
 * version of it is two points. The page range drives every figure; this drives
 * the trend behind the biggest one.
 */
const HERO_MONTHS = [
  { key: '3', label: '3m' },
  { key: '6', label: '6m' },
  { key: '12', label: '12m' },
];

/**
 * The executive view.
 *
 * The hero renders one *channel's* cost per funded deal, named as one
 * channel's, with its coverage and its range. A blended figure across every
 * channel has a different denominator — total marketing spend over total
 * marketing-sourced deals — and is not computable until every channel is
 * ingested. Showing the one live channel's number under a blended label would
 * be the most expensive kind of quiet error: right arithmetic, wrong noun, on
 * the screen the client repeats internally.
 *
 * Where that used to be a paragraph on a black band, it is now the card's
 * subtitle, its ⓘ and a row in the data-quality card (spec v2 §2).
 */
export default async function ExecutiveView({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{ days?: string; hero?: string; model?: string }>;
}) {
  const { tenant: slug } = await params;
  const query = await searchParams;
  const session = await requireTenant(slug);

  const model: AttributionModel = query.model === 'first_touch' ? 'first_touch' : 'last_touch';
  const days = WINDOWS.some((w) => w.key === query.days) ? Number(query.days) : 90;
  // Six months by default. Twelve leaves two thirds of the plot area blank
  // until a year of spend has been ingested, and the blank is honest but it is
  // not informative.
  const heroMonths = HERO_MONTHS.some((m) => m.key === query.hero) ? Number(query.hero) : 6;

  const today = tenantDay(new Date(), session.tenant.timezone);
  const range = trailingWindow(today, days);
  const prior = previousRange(range);
  const currency = session.tenant.currency;

  const [data, previous, buckets, heroBuckets, metrics, quality, unread, ingestion, rateFloor] =
    await Promise.all([
    monthlyPerformance(session, range, model),
    monthlyPerformance(session, prior, model),
    // Twelve monthly buckets for the mini charts, whatever the page range: a
    // sparkline of three weeks says nothing, and the figure above it already
    // carries the range.
    windowBuckets(session, trailingMonths(today, 12), 'month', model),
    windowBuckets(session, trailingMonths(today, heroMonths), 'month', model),
    loadMetrics(session),
    dataQuality(session),
    unreadNotifications(session),
    ingestionStart(session),
    minRateDenominator(session),
  ]);

  /**
   * Whether the comparison period can be compared against at all.
   *
   * Paid media was first pulled on 2026-06-20 and the CRM sync reaches back to
   * 2024, so the 90 days before this window are a valid baseline for funded
   * deals and a meaningless one for spend: the account was spending and nobody
   * ingested it. A delta against that baseline reads as performance; it is an
   * ingestion boundary. So the two have separate baselines, and a baseline of
   * `null` renders as a stated absence.
   */
  const spendComparable = covers(ingestion.spendFrom, prior);
  const crmComparable = covers(ingestion.crmFrom, prior);
  const notIngested = (from: string | null) =>
    from ? `not ingested before ${from}` : 'nothing ingested yet';

  const valueStage = data.stages.find((s) => s.countsValue);
  const valueKey = valueStage?.key ?? null;
  const valueLabel = valueStage?.label ?? 'Funded';

  // The channel carrying the most spend in the window is the one the hero
  // speaks for. Named explicitly, never implied — and when a second channel
  // arrives this is where the blended figure will replace it.
  const lead = [...data.channels].sort((a, b) => b.spend - a.spend)[0] ?? null;
  const leadPrevious = lead
    ? (previous.channels.find((c) => c.platform === lead.platform) ?? null)
    : null;

  const dealsIn = (stages: Record<string, number>) => (valueKey ? (stages[valueKey] ?? 0) : 0);
  const attributedDeals = (source: typeof data) =>
    source.channels.reduce((sum, c) => sum + dealsIn(c.stages), 0);

  /** One channel's cost per deal for a bucket, both halves from that bucket. */
  const bucketCost = (bucket: WindowBucket, platform: string) =>
    channelCostPerDeal({
      channelSpend: bucket.spendByPlatform[platform] ?? 0,
      attributedDeals: valueKey ? (bucket.stagesByPlatform[platform]?.[valueKey] ?? 0) : 0,
      unattributedDeals: valueKey ? (bucket.unattributedStages[valueKey] ?? 0) : 0,
    });

  const heroPoints = heroBuckets.map((bucket) => ({
    label: bucket.label,
    value: !bucket.spendIngested || !lead ? null : bucketCost(bucket, lead.platform).value,
    provisional: bucket.provisional,
  }));

  // The last four months of the metric, each against the month before it.
  const monthlyCost = buckets.map((bucket) =>
    !bucket.spendIngested || !lead ? null : bucketCost(bucket, lead.platform).value,
  );
  const secondary: SecondaryFigure[] = buckets
    .map((bucket, i): SecondaryFigure => {
      const value = monthlyCost[i] ?? null;
      const baseline = monthlyCost[i - 1] ?? null;
      return {
        label: bucket.label,
        value: value === null ? null : formatCurrency(value, currency),
        current: value,
        baseline,
      };
    })
    .filter((figure) => figure.value !== null)
    .slice(-4);

  /**
   * A mini series. `source` decides which ingestion boundary blanks a bucket:
   * a spend series has nothing to say about March 2026, and plotting zero there
   * would say the account spent nothing.
   */
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

  /**
   * Offer rate, from configuration rather than from the word "offer".
   *
   * `stage_conversion_rate(from, to)` over `funnel_stages`; the two stages are
   * the metric's own arguments. Where either end is a stage nobody stamps in
   * the CRM, there is no rate — not a low one — and the card says so.
   */
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

  const attributedShare = (source: typeof data) => {
    const total = dealsIn(source.total.stages);
    return total === 0 ? null : attributedDeals(source) / total;
  };

  const notes: MethodNote[] = [
    {
      heading: `Cost per ${valueLabel.toLowerCase()} deal`,
      body:
        metrics.northStar?.definition ??
        'A channel’s spend in the period over the deals attributed to that channel.',
      detail: BLENDED_NOTE(valueLabel),
    },
    {
      heading: 'Deals no channel can claim',
      body: data.unattributed.reason,
      detail: `${formatCount(dealsIn(data.unattributed.stages))} of ${formatCount(
        dealsIn(data.total.stages),
      )} ${valueLabel.toLowerCase()} deals in this window.`,
    },
    ...(lead
      ? [
          {
            heading: 'Coverage and range',
            body: coverageExplanation(lead.costPerDeal, currency, lead.label),
          },
        ]
      : []),
    ...quality.map((item) => ({
      heading: item.name,
      body: item.detail || item.summary,
      detail: item.since ? `Outstanding since ${item.since.toISOString().slice(0, 10)}.` : undefined,
    })),
  ];

  const base = `/${slug}`;
  const activeParams = { days: String(days), hero: String(heroMonths), model };

  return (
    <>
      <TopBar tenant={session.tenant} viewer={session.viewer} title="Executive" unread={unread}>
        <Segmented
          label="Date range"
          active={String(days)}
          options={segments(base, activeParams, 'days', WINDOWS)}
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
        <MethodDrawer notes={notes} title={`Executive · ${range.start} to ${range.end}`} />
      </PageMeta>

      <Grid>
        {lead ? (
          <HeroCard
            metricLabel={metrics.northStar?.label ?? `Cost per ${valueLabel.toLowerCase()} deal`}
            channelLabel={lead.label}
            cost={lead.costPerDeal}
            previousCost={spendComparable ? (leadPrevious?.costPerDeal ?? null) : null}
            comparisonUnavailable={notIngested(ingestion.spendFrom)}
            currency={currency}
            direction={metrics.direction('cost_per_funded_deal')}
            points={heroPoints}
            target={
              metrics.target('cost_per_funded_deal') !== null
                ? {
                    value: metrics.target('cost_per_funded_deal')!,
                    label: `Target ${formatCurrency(metrics.target('cost_per_funded_deal')!, currency)}`,
                  }
                : null
            }
            secondary={secondary}
            periodToggle={
              <Segmented
                label="Chart period"
                active={String(heroMonths)}
                options={segments(base, activeParams, 'hero', HERO_MONTHS)}
              />
            }
            provisional={heroBuckets.at(-1)?.provisional ?? false}
            definition={metrics.northStar?.definition ?? null}
            blendedNote={BLENDED_NOTE(valueLabel)}
          />
        ) : (
          <DataQualityCard
            items={quality}
            span={8}
            title="No channel has reported in this window"
          />
        )}

        <div className="col-span-12 flex flex-col gap-6 lg:col-span-4">
          <KpiCard
            span={6}
            label={`${valueLabel} volume`}
            value={formatCurrency(data.total.valueVolume, currency)}
            delta={
              <Delta
                current={data.total.valueVolume}
                baseline={crmComparable ? previous.total.valueVolume : null}
                direction={metrics.direction('funded_volume')}
                unavailable={notIngested(ingestion.crmFrom)}
              />
            }
            context="Every source, attributed or not"
            points={mini((b) => b.valueVolume)}
            info="The funded amount on every deal reaching the value stage in the period, from any source. Not a channel figure: no spend is divided into it."
          />
          <KpiCard
            span={6}
            label={`${valueLabel} deals`}
            value={formatCount(dealsIn(data.total.stages))}
            delta={
              <Delta
                current={dealsIn(data.total.stages)}
                baseline={crmComparable ? dealsIn(previous.total.stages) : null}
                direction={metrics.direction('funded_deals')}
                unavailable={notIngested(ingestion.crmFrom)}
              />
            }
            context={`${formatCount(attributedDeals(data))} attributed · ${formatCount(
              dealsIn(data.unattributed.stages),
            )} to no channel`}
            points={mini((b) => (valueKey ? (b.stages[valueKey] ?? 0) : null))}
            variant="bars"
            info="Deals reaching the value stage in the period. The attributed count is the only one that enters a channel's denominator."
          />
        </div>

        <KpiCard
          label="Paid media spend"
          value={formatCurrency(data.total.spend, currency)}
          delta={
            <Delta
              current={data.total.spend}
              baseline={spendComparable ? previous.total.spend : null}
              direction={metrics.direction('paid_media_spend')}
              unavailable={notIngested(ingestion.spendFrom)}
            />
          }
          context={`${data.channels.length} connected ${
            data.channels.length === 1 ? 'channel' : 'channels'
          }`}
          points={mini((b) => b.spend, 'spend')}
          info="Spend across every connected channel in the period. No metric declares a direction for it: spending less is not an achievement and spending more is not a failure — what it bought decides that."
        />

        <KpiCard
          label="Attributed share"
          value={
            attributedShare(data) === null ? null : formatRate(attributedShare(data)!)
          }
          notMeasured={`No ${valueLabel.toLowerCase()} deal in this window`}
          delta={
            attributedShare(data) !== null ? (
              <Delta
                current={attributedShare(data)!}
                // Attribution needs ingested clicks, so the boundary is the
                // spend one: before it, every deal looks unattributed and the
                // share would read as a collapse that never happened.
                baseline={
                  spendComparable && attributedShare(previous) !== null
                    ? attributedShare(previous)
                    : null
                }
                direction={metrics.direction('attributed_share')}
                unavailable={notIngested(ingestion.spendFrom)}
              />
            ) : (
              <NoDelta />
            )
          }
          context={`${formatCount(attributedDeals(data))} of ${formatCount(
            dealsIn(data.total.stages),
          )} deals reach a channel`}
          points={mini((b) => {
            if (!valueKey) return null;
            const total = b.stages[valueKey] ?? 0;
            if (total === 0) return null;
            const attributed = Object.values(b.stagesByPlatform).reduce(
              (sum, stages) => sum + (stages[valueKey] ?? 0),
              0,
            );
            return attributed / total;
          }, 'spend')}
          info="Deals the platform can attribute to a connected channel, over every deal reaching the value stage. A measure of coverage, not of performance."
        />

        <KpiCard
          label={offerMetric?.label ?? 'Offer rate'}
          value={
            offerBlocked || offerRate(data) === null ? null : formatRate(offerRate(data)!)
          }
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
              : offerMetric?.definition ??
                'One instance of the generic stage conversion rate over the configured stages.'
          }
        />

        <KpiCard
          label="Applications"
          value={formatCount(data.total.stages.application ?? 0)}
          delta={
            <Delta
              current={data.total.stages.application ?? 0}
              baseline={crmComparable ? (previous.total.stages.application ?? 0) : null}
              direction={metrics.direction('applications')}
              unavailable={notIngested(ingestion.crmFrom)}
            />
          }
          context="Opportunities created in the period"
          points={mini((b) => b.stages.application ?? 0)}
          variant="bars"
          info="Opportunities reaching the Application stage. This is what the CRM actually stamps; the inbound lead population above it is a different grain."
        />

        <DataQualityCard items={quality} span={4} />
        <ChannelSnapshot data={data} currency={currency} valueLabel={valueLabel} span={8} />
      </Grid>

      <MethodNotesForPrint notes={notes} />
    </>
  );
}

/** Why no blended figure appears. One place, so both the ⓘ and the drawer agree. */
function BLENDED_NOTE(valueLabel: string): string {
  return (
    `This is one channel’s figure, not a blended one. Blended cost per ` +
    `${valueLabel.toLowerCase()} deal divides total marketing spend by total ` +
    `marketing-sourced deals, and needs every channel in the engagement ingested ` +
    `before it means anything.`
  );
}
