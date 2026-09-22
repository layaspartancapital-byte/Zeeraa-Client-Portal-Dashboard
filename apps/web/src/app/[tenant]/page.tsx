import {
  briefingPeriods,
  budgetPacing,
  canAdministerTenant,
  channelCostPerDeal,
  formatCount,
  formatCurrency,
  formatDuration,
  formatRangeLabel,
  formatRate,
  improvementDirectionFor,
  monthKeyOf,
  rampMonthKey,
  rampSeries,
  tenantDay,
  trailingMonths,
  type AttributionModel,
  type RampMetricKey,
} from '@zeeraa/core';
import { Card, CardHeader, Grid } from '@/components/ui/Card';
import { ButtonLink } from '@/components/ui/Button';
import { InfoTip } from '@/components/ui/InfoTip';
import { MethodDrawer, MethodNotesForPrint, type MethodNote } from '@/components/ui/Drawer';
import { PageMeta, TopBar } from '@/components/shell/TopBar';
import { PrintButton, SyncNowButton } from '@/components/shell/actions';
import { AutoRefresh } from '@/components/shell/AutoRefresh';
import { FunnelStages } from '@/components/FunnelStages';
import { DataQualityCard } from '@/components/DataQualityCard';
import { EfficiencyTable, type EfficiencyRow } from '@/components/EfficiencyTable';
import { NeedsAttention, type Finding } from '@/components/NeedsAttention';
import { RampCard, type RampPanel } from '@/components/RampCard';
import { SourceFreshness } from '@/components/SourceFreshness';
import { SpendPacingCard } from '@/components/SpendPacingCard';
import { callReport, monthlyPerformance } from '@/lib/reporting';
import {
  alowareConnectedThreshold,
  connectionHealth,
  dataQuality,
  engagementRamp,
  loadMetrics,
  maxRateLeakage,
  pausedCampaigns,
  sourceFreshness,
  windowBuckets,
} from '@/lib/dashboard';
import { requireTenant } from '@/lib/tenant';
import { Download } from 'lucide-react';

export async function generateMetadata({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const { tenant } = await requireTenant(slug);
  return { title: { absolute: `${tenant.name} · Executive briefing` } };
}

/**
 * How long a render may be reused, and how often the page refetches itself.
 *
 * One hour, because that is the sync cadence: `vercel.json` runs
 * `/api/cron/sync` hourly, so between runs there is nothing new to draw and a
 * shorter interval would only cost queries. `AutoRefresh` runs the client half
 * on the same number, so a tab left open all afternoon does not sit on a
 * morning render behind a freshness strip that was also rendered that morning.
 */
export const revalidate = 3600;

/**
 * The executive briefing.
 *
 * **A standing report, not a windowed metrics page**, and the difference is
 * structural rather than cosmetic.
 *
 * There is no date control. A briefing that can be rescoped is a screen two
 * readers quote different numbers from, and the question leadership brings to
 * it — is the engagement on track — is not a question about an arbitrary
 * window. So each block states its own period in words and none of them can
 * disagree:
 *
 *   * **the ramp** covers the engagement, on an M1–M8 axis;
 *   * **every measured figure** covers this month to date, with the last whole
 *     month beside it;
 *   * **the findings** are current state, and not a period at all.
 *
 * Month to date against a whole month is deliberately two different lengths.
 * That is how a business talks about its own month, and the mismatch is handled
 * by never subtracting a *count* in one from a count in the other — those sit
 * as two figures. Rates and costs do compare, because neither scales with the
 * number of days.
 *
 * It serves two readers at once, which is what decides the contents. Spartan's
 * leadership get the commitment, the funnel and what needs doing. Zeeraa's team
 * get the coverage under every figure, the data-quality card, and the findings
 * that are theirs to close — a paused campaign, a degraded connector, a stage
 * nobody stamps.
 */
export default async function ExecutiveBriefing({
  params,
}: {
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: slug } = await params;
  const session = await requireTenant(slug);
  const currency = session.tenant.currency;

  /**
   * Last touch, and not a choice the reader makes.
   *
   * The model toggle went with the date picker. No deal in this engagement has
   * more than one touch yet, so the two models cannot diverge; when one does,
   * the monthly performance screen is where that comparison belongs. A briefing
   * that can be re-run under a different attribution model is a briefing two
   * people quote different numbers from.
   */
  const model: AttributionModel = 'last_touch';

  const today = tenantDay(new Date(), session.tenant.timezone);
  const periods = briefingPeriods(today);
  const { monthToDate, lastFullMonth } = periods;

  const connectedThreshold = await alowareConnectedThreshold(session);

  const [
    current,
    previous,
    buckets,
    metrics,
    quality,
    ramp,
    calls,
    connections,
    paused,
    freshness,
    leakage,
  ] = await Promise.all([
    monthlyPerformance(session, monthToDate, model),
    monthlyPerformance(session, lastFullMonth, model),
    // Twelve monthly buckets, which serve both the mini charts and the ramp's
    // actuals: the ramp needs one figure per calendar month, and this is
    // already one figure per calendar month, per channel.
    windowBuckets(session, trailingMonths(today, 12), 'month', model),
    loadMetrics(session),
    dataQuality(session),
    engagementRamp(session),
    callReport(session, monthToDate, connectedThreshold),
    connectionHealth(session),
    pausedCampaigns(session, lastFullMonth.start),
    sourceFreshness(session),
    maxRateLeakage(session),
  ]);

  const valueStage = current.stages.find((s) => s.countsValue);
  const valueKey = valueStage?.key ?? null;
  const valueLabel = valueStage?.label ?? 'Funded';

  const dealsIn = (stages: Record<string, number>) => (valueKey ? (stages[valueKey] ?? 0) : 0);
  const attributedDeals = (source: typeof current) =>
    source.channels.reduce((sum, c) => sum + dealsIn(c.stages), 0);

  const mtdLabel = `${formatRangeLabel(monthToDate)} · month to date`;
  const lastMonthLabel = formatRangeLabel(lastFullMonth);

  /* ----------------------------------------------------------------------- */
  /* The ramp                                                                */
  /* ----------------------------------------------------------------------- */

  /**
   * The channel the engagement contracts against.
   *
   * One platform has a ramp — Google Ads — and a second one inheriting its
   * curve would put a number on screen that no contract states. Where several
   * are contracted this takes the first, and the card names which.
   */
  const rampPlatform = [...ramp.byPlatform.keys()][0] ?? 'google_ads';
  const rampTargets = ramp.byPlatform.get(rampPlatform) ?? [];

  /**
   * A month's bucket, but only once the month is over.
   *
   * **The ramp contracts a monthly figure, so only a finished month has an
   * actual.** September is three weeks old and holds one deal attributed to
   * Google Ads; dividing the month's spend so far by it gives $18,792 against a
   * $3,321 target, and the card would report the engagement as catastrophically
   * behind plan on the strength of a month that has not happened yet. By the
   * 30th the same month may land near target.
   *
   * The current month is not missing from the briefing — it is the three KPI
   * cards directly below this one, labelled as month to date. What it is not is
   * a point on a curve of monthly results.
   */
  const completedBucketFor = (month: string) =>
    month >= periods.currentMonth
      ? null
      : (buckets.find((b) => monthKeyOf(b.start) === month) ?? null);

  /**
   * A month's cost, or nothing where the month's denominator is too small to
   * carry one.
   *
   * The same gate the efficiency table uses, applied a second time because a
   * point on a chart is a stronger claim than a cell in a table: a reader takes
   * a line as a trajectory. A month in which one deal was attributed produces a
   * cost per deal that is a fact about that deal, and joining it to the month
   * either side of it draws a shape that is not in the data.
   */
  const gatedCost = (spend: number, attributed: number, formulaKey: string) => {
    if (!metrics.population(formulaKey, attributed).sufficient) return null;
    return channelCostPerDeal({ channelSpend: spend, attributedDeals: attributed }).value;
  };

  /**
   * What actually happened in a calendar month, per contracted metric.
   *
   * Every one of these takes both halves from the contracted channel. A ramp
   * signed for Google Ads is kept or missed by Google Ads' own spend over
   * Google Ads' own deals; measuring it against the account total would let the
   * engagement look on track because a different channel had a good month.
   */
  const actualFor: Record<RampMetricKey, (month: string) => number | null> = {
    costPerFundedDeal: (month) => {
      const bucket = completedBucketFor(month);
      if (!bucket || !bucket.spendIngested || !valueKey) return null;
      return gatedCost(
        bucket.spendByPlatform[rampPlatform] ?? 0,
        bucket.stagesByPlatform[rampPlatform]?.[valueKey] ?? 0,
        'cost_per_funded_deal',
      );
    },
    cpa: (month) => {
      const bucket = completedBucketFor(month);
      if (!bucket || !bucket.spendIngested) return null;
      /*
       * **The model's "A" is an approval, and this is the denominator that
       * proves it.**
       *
       * The engagement model computes its own CPA column as budget ÷ approvals,
       * and reproduces it to the dollar in all eight months — $30,000 ÷ 40 =
       * $750, $316,241 ÷ 603.8 = $524. So the actual has to divide by
       * underwriting approvals or it is not comparable to the curve it is drawn
       * against.
       *
       * This was cost per *application* until the model file was read, which
       * would have understated the actual by roughly threefold — 121
       * applications against 41 approvals in September — and drawn the
       * engagement as comfortably ahead of a target it is behind. The word CPA
       * means at least three different things across this engagement's
       * paperwork; `cpa_definition` in `blocked_dependencies` carries that
       * disagreement, and the ramp is exempt from it only because the model
       * defines its own column from its own two columns.
       */
      return gatedCost(
        bucket.spendByPlatform[rampPlatform] ?? 0,
        bucket.stagesByPlatform[rampPlatform]?.uw_approved ?? 0,
        'cpa',
      );
    },
    budget: (month) => {
      const bucket = completedBucketFor(month);
      return bucket?.spendIngested ? (bucket.spendByPlatform[rampPlatform] ?? 0) : null;
    },
    approvals: (month) => {
      const bucket = completedBucketFor(month);
      return bucket?.crmIngested ? (bucket.stagesByPlatform[rampPlatform]?.uw_approved ?? 0) : null;
    },
    fundedDeals: (month) => {
      const bucket = completedBucketFor(month);
      if (!bucket || !bucket.crmIngested || !valueKey) return null;
      return bucket.stagesByPlatform[rampPlatform]?.[valueKey] ?? 0;
    },
  };

  const panelFor = (
    metric: RampMetricKey,
    label: string,
    formulaKey: string,
    format: RampPanel['format'],
    missing: string,
  ): RampPanel => {
    // The direction comes from the formula, exactly as every delta's does. A
    // ramp panel never states which way is better.
    const direction = improvementDirectionFor(formulaKey);
    return {
      metric,
      label,
      format,
      direction,
      missing,
      series: rampSeries(rampTargets, metric, {
        startMonth: ramp.startMonth,
        actualFor: actualFor[metric],
        direction,
      }),
    };
  };

  const AWAITING_MODEL =
    'The engagement model contracts this month by month. The figures have not been entered ' +
    'in the engagement targets yet, so there is no curve to track against.';

  const rampPrimary = panelFor(
    'costPerFundedDeal',
    `Cost per ${valueLabel.toLowerCase()} deal`,
    'cost_per_funded_deal',
    { kind: 'currency', currency },
    AWAITING_MODEL,
  );
  const rampSecondary = panelFor(
    'cpa',
    'CPA · cost per approval',
    'cpa',
    { kind: 'currency', currency },
    AWAITING_MODEL,
  );
  const rampCompact: RampPanel[] = [
    panelFor(
      'budget',
      'Budget',
      'paid_media_spend',
      { kind: 'currency', currency },
      'Only M1 of the budget curve has been entered, so later months have nothing to pace against.',
    ),
    panelFor('approvals', 'Approvals', 'stage_count', { kind: 'projection' }, AWAITING_MODEL),
    // Kept beside CPA deliberately: they share a denominator, and a reader who
    // wonders what the "A" is can see it one line down.
    panelFor(
      'fundedDeals',
      `${valueLabel} deals`,
      'stage_count',
      { kind: 'projection' },
      AWAITING_MODEL,
    ),
  ];

  /* ----------------------------------------------------------------------- */
  /* Pacing                                                                  */
  /* ----------------------------------------------------------------------- */

  /**
   * This month's contracted budget, which needs both halves of the ramp.
   *
   * The budget sits on a ramp month, and knowing which calendar month that is
   * needs the start month. They are two pieces of the same missing
   * configuration, so the card names the one that is absent rather than
   * reporting "no budget" for two different reasons.
   */
  const currentRampMonth =
    ramp.startMonth === null
      ? null
      : (rampTargets.find(
          (t) => rampMonthKey(ramp.startMonth!, t.monthIndex) === periods.currentMonth,
        ) ?? null);

  const pacing =
    currentRampMonth?.budget == null
      ? null
      : budgetPacing({
          spent: current.total.spend,
          budget: currentRampMonth.budget,
          elapsed: periods.elapsed,
        });

  const budgetMissing =
    ramp.startMonth === null
      ? 'No contracted budget applies: the engagement start month is not recorded, so no ramp month lands on this one.'
      : currentRampMonth === null
        ? `This month falls outside the contracted ramp, which runs M1 to M${formatCount(rampTargets.length)}.`
        : 'No budget is recorded for this month of the ramp.';

  /* ----------------------------------------------------------------------- */
  /* Efficiency                                                              */
  /* ----------------------------------------------------------------------- */

  /**
   * The stages a cost is worth reporting per, from the configured funnel rather
   * than named here — a tenant whose funnel has different steps gets its own
   * columns.
   *
   * A blocked stage is dropped rather than shown empty: a cost per a stage
   * nobody stamps would divide by a number the funnel itself declines to
   * render, two rows above.
   */
  const efficiencyColumns = current.stages
    .filter(
      (stage) =>
        ['lead', 'application', 'uw_approved'].includes(stage.key) || stage.key === valueKey,
    )
    .filter((stage) => !current.stageStatus[stage.key]?.blocked)
    .map((stage) => ({ stage: stage.key, label: stage.label }));

  const efficiencyRows: EfficiencyRow[] = [...current.channels]
    .sort((a, b) => b.spend - a.spend)
    .map((channel) => ({
      platform: channel.platform,
      label: channel.label,
      spend: channel.spend,
      cells: efficiencyColumns.map((column) => {
        const cost = channelCostPerDeal({
          channelSpend: channel.spend,
          attributedDeals: channel.stages[column.stage] ?? 0,
          unattributedDeals: current.unattributed.stages[column.stage] ?? 0,
        });
        return {
          stage: column.stage,
          cost,
          // Gated on the population this cell divided by, not the row's. Google
          // Ads can claim 185 leads and one funded deal in the same month, and
          // those two figures are supported to completely different degrees.
          gate: metrics.population(
            column.stage === valueKey ? 'cost_per_funded_deal' : 'cost_per_stage',
            cost.attributedDeals,
          ),
        };
      }),
    }));

  /* ----------------------------------------------------------------------- */
  /* Findings                                                                */
  /* ----------------------------------------------------------------------- */

  const speedGate = metrics.population('speed_to_lead', calls.speed.called);
  const unattributedDeals = dealsIn(current.unattributed.stages);
  const totalDeals = dealsIn(current.total.stages);
  const degraded = connections.filter(
    (c) => c.status === 'degraded' || c.status === 'failing' || c.status === 'waiting_on_client',
  );
  const pausedRecent = paused.filter((p) => p.pausedWithRecentSpend > 0);
  const pausedTotal = paused.reduce((sum, p) => sum + p.paused, 0);

  const findings: Finding[] = [];

  if (speedGate.sufficient && calls.speed.medianSeconds !== null) {
    findings.push({
      key: 'speed-to-lead',
      // The five-minute bar is the industry's own, not one this product sets,
      // and the desk being a long way off it is an operational finding rather
      // than a metric reading.
      level: (calls.speed.withinFiveMinutesShare ?? 0) < 0.5 ? 'act' : 'watch',
      headline: 'Leads wait for a first call',
      figure: formatDuration(calls.speed.medianSeconds),
      detail:
        `median over ${formatCount(calls.speed.called)} of ${formatCount(
          calls.speed.called + calls.speed.notCalled,
        )} leads called · ` +
        `${
          calls.speed.withinFiveMinutesShare === null
            ? 'none'
            : formatRate(calls.speed.withinFiveMinutesShare)
        } reached within five minutes`,
      note: 'Measured only over leads that were called — a lead nobody rang has no response time and is not counted as a slow one. Five minutes is the industry bar, not one this product sets.',
      action: { label: 'Funnel', href: `/${slug}/funnel` },
    });
  }

  if (!calls.empty) {
    findings.push({
      key: 'call-volume',
      level: 'watch',
      headline: 'Calls this month',
      figure: formatCount(calls.volume.handled),
      detail:
        `${
          calls.volume.connectRate === null ? 'none' : formatRate(calls.volume.connectRate)
        } connected past ${formatCount(calls.connectedMinTalkSeconds)}s · ` +
        `${formatCount(calls.volume.abandoned)} abandoned, in neither count`,
      note: `A call that talked for less than ${formatCount(calls.connectedMinTalkSeconds)} seconds is an attempt rather than a conversation. Abandoned calls — the caller hung up before anybody answered — are outside both counts and outside the connect rate's denominator.`,
      action: { label: 'Funnel', href: `/${slug}/funnel` },
    });
  }

  if (pausedRecent.length > 0) {
    const count = pausedRecent.reduce((sum, p) => sum + p.pausedWithRecentSpend, 0);
    const spend = pausedRecent.reduce((sum, p) => sum + p.recentSpend, 0);
    findings.push({
      key: 'paused-campaigns',
      level: 'act',
      headline: 'Campaigns that were spending are paused',
      figure: formatCount(count),
      detail:
        `${formatCurrency(spend, currency)} spent before they stopped · ` +
        `${formatCount(pausedTotal)} paused campaigns configured in total`,
      note: 'Counted from the platform’s own status. Removed campaigns are excluded — a deleted campaign is one somebody cleaned up, not a configuration left behind.',
      action: { label: 'Platforms', href: `/${slug}/platforms/${pausedRecent[0]!.platform}` },
    });
  }

  for (const connection of degraded) {
    findings.push({
      key: `connection-${connection.platform}`,
      // A dependency on the client is not a fault. It still belongs here —
      // somebody has to chase it — but it is not something Zeeraa broke.
      level: connection.status === 'waiting_on_client' ? 'watch' : 'act',
      headline: `${connection.label} is ${connection.status.replace(/_/g, ' ')}`,
      figure: connection.lastSyncAt
        ? connection.lastSyncAt.toLocaleDateString('en-US', {
            timeZone: session.tenant.timezone,
            month: 'short',
            day: 'numeric',
          })
        : 'never synced',
      detail: connection.detail ?? 'The connector reported a problem on its last run.',
      action: { label: 'Connections', href: `/${slug}/connections` },
    });
  }

  if (unattributedDeals > 0) {
    findings.push({
      key: 'unattributed',
      level: 'watch',
      headline: `${valueLabel} deals no channel can claim`,
      figure: `${formatCount(unattributedDeals)} of ${formatCount(totalDeals)}`,
      detail:
        'They carry no click from any connected channel, so no spend stands behind them and ' +
        'they are in no channel’s denominator',
      note: current.unattributed.reason,
      action: { label: 'Reconciliation', href: `/${slug}/reconciliation` },
    });
  }

  /* ----------------------------------------------------------------------- */
  /* Notes                                                                   */
  /* ----------------------------------------------------------------------- */

  const notes: MethodNote[] = [
    {
      heading: 'What period this briefing covers',
      body:
        'The ramp covers the engagement on an M1–M8 axis. Every measured figure covers this ' +
        'month to date, with the last whole month beside it. The findings are current state.',
      detail:
        `Month to date is ${formatRangeLabel(monthToDate)}; the last whole month is ` +
        `${lastMonthLabel}. A count from one is never subtracted from a count in the other — ` +
        'they are different lengths — so those sit as two figures. Rates and costs do compare, ' +
        'because neither scales with the number of days.',
    },
    {
      heading: 'The engagement ramp',
      body:
        'The contract commits a figure for each month of the engagement, so the ramp is drawn ' +
        'on an M1–M8 axis rather than a calendar one.',
      detail:
        ramp.startMonth === null
          ? 'The start month is not recorded, so no ramp month maps to a calendar month and no actual is plotted against the curve. The commitment itself is fully specified and is drawn.'
          : `M1 is ${ramp.startMonth}.`,
    },
    {
      heading: 'Cost per stage',
      body:
        'Each figure is one channel’s spend over the records attributed to that channel at that ' +
        'stage. Nothing here is blended across channels.',
      detail: `Withheld below ${formatCount(
        metrics.floors.render,
      )} in its own denominator, because a cost over one or two records measures the sample rather than the channel.`,
    },
    {
      heading: 'How current these figures are',
      body:
        'Paid media and the CRM are pulled hourly, so a figure covering today reaches only as ' +
        'far as the last run. Calls are pushed by webhook as each one ends, and this page ' +
        'refetches itself on the same hourly cadence.',
      detail: freshness
        .map(
          (source) =>
            `${source.label}: ${
              source.at === null
                ? 'nothing received'
                : source.at.toLocaleString('en-US', {
                    timeZone: session.tenant.timezone,
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })
            }`,
        )
        .join(' · '),
    },
    {
      heading: 'Deals no channel can claim',
      body: current.unattributed.reason,
      detail: `${formatCount(unattributedDeals)} of ${formatCount(
        totalDeals,
      )} ${valueLabel.toLowerCase()} deals this month.`,
    },
    ...quality.map((item) => ({
      heading: item.name,
      body: item.detail || item.summary,
      detail: item.since ? `Outstanding since ${item.since.toISOString().slice(0, 10)}.` : undefined,
    })),
  ];

  const exportParams = new URLSearchParams({ from: monthToDate.start, to: monthToDate.end, model });

  return (
    <>
      <TopBar tenant={session.tenant} viewer={session.viewer} title="Executive briefing">
        <ButtonLink href={`/api/export/${slug}/performance?${exportParams.toString()}`}>
          <Download aria-hidden="true" className="h-4 w-4" />
          Export CSV
        </ButtonLink>
        <PrintButton />
        {canAdministerTenant(session.tenant.role) && (
          <SyncNowButton slug={slug} platform="google_ads" />
        )}
      </TopBar>

      <PageMeta>
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <SourceFreshness
            sources={freshness}
            now={new Date()}
            timezone={session.tenant.timezone}
            includesToday
          />
          <AutoRefresh intervalSeconds={revalidate} />
        </span>
        <MethodDrawer
          notes={notes}
          title={`Executive briefing · ${formatRangeLabel(monthToDate)}`}
        />
      </PageMeta>

      <Grid>
        {/* 1. The commitment — the only thing here that is not a measurement. */}
        <RampCard
          platformLabel={
            current.channels.find((c) => c.platform === rampPlatform)?.label ?? rampPlatform
          }
          primary={rampPrimary}
          secondary={rampSecondary}
          compact={rampCompact}
          startMonth={ramp.startMonth}
        />

        {/* 2. The outcome, and the spend that bought it. */}
        <TwoPeriodKpi
          label={`${valueLabel} deals`}
          value={formatCount(totalDeals)}
          priorValue={formatCount(dealsIn(previous.total.stages))}
          valueLabel={mtdLabel}
          priorLabel={lastMonthLabel}
          context={`${formatCount(attributedDeals(current))} attributed · ${formatCount(
            unattributedDeals,
          )} to no channel`}
          info="Deals reaching the value stage. Shown for both periods and never subtracted: a partial month against a whole one is mostly a difference in calendar days."
        />
        <TwoPeriodKpi
          label={`${valueLabel} volume`}
          value={formatCurrency(current.total.valueVolume, currency)}
          priorValue={formatCurrency(previous.total.valueVolume, currency)}
          valueLabel={mtdLabel}
          priorLabel={lastMonthLabel}
          context="Every source, attributed or not"
          info="The funded amount on every deal reaching the value stage, from any source. Not a channel figure: no spend is divided into it."
        />
        <SpendPacingCard
          spent={current.total.spend}
          pacing={pacing}
          currency={currency}
          periodLabel={mtdLabel}
          budgetMissing={budgetMissing}
          elapsedDays={periods.elapsedDays}
          monthDays={periods.monthDays}
          points={buckets.map((bucket) => ({
            label: bucket.label,
            value: bucket.spendIngested ? bucket.spend : null,
            provisional: bucket.provisional,
          }))}
          span={6}
        />

        {/* 3. The funnel, every stage and the rate between each pair. */}
        <Card span={12}>
          <CardHeader
            title="Funnel"
            subtitle={`Every stage and the conversion between them · ${mtdLabel}`}
          />
          <FunnelStages
            data={current}
            counts={current.total.stages}
            populationLabel="every source"
            maxLeakage={leakage}
          />
        </Card>

        {/* 4. What each stage costs, per channel. */}
        <EfficiencyTable
          rows={efficiencyRows}
          columns={efficiencyColumns}
          unattributed={{
            label: current.unattributed.label,
            reason: current.unattributed.reason,
            counts: current.unattributed.stages,
          }}
          currency={currency}
          periodLabel={mtdLabel}
        />

        {/* 5. What to do about it, and what the platform cannot say. */}
        <NeedsAttention findings={findings} span={8} />
        <DataQualityCard items={quality} span={4} />
      </Grid>

      <MethodNotesForPrint notes={notes} />
    </>
  );
}

/**
 * A figure for this month beside the same figure for the last whole month.
 *
 * Two figures, not a delta, and the reason is arithmetic rather than taste: one
 * covers twenty-two days and the other thirty-one, so most of the difference
 * between them is the calendar. A percentage would be read as performance.
 * Rates and costs elsewhere on this screen do carry deltas, because neither
 * scales with the number of days in the period.
 *
 * No mini chart. Every other KPI in this product has one, and the exception is
 * deliberate: the second figure *is* the comparison here, and a twelve-month
 * sparkline under two periods invites a reader to compare three things at
 * different grains at once.
 */
function TwoPeriodKpi({
  label,
  value,
  priorValue,
  valueLabel,
  priorLabel,
  context,
  info,
  span = 3,
}: {
  label: string;
  value: string;
  priorValue: string;
  valueLabel: string;
  priorLabel: string;
  context?: string;
  info?: string;
  span?: 3 | 4 | 6;
}) {
  return (
    <Card span={span} className="justify-between">
      <div className="px-5 pb-5 pt-4">
        <p className="flex items-center gap-1.5 text-[13px] font-medium text-text-2">
          {label}
          {info && <InfoTip label={`How ${label} is measured`}>{info}</InfoTip>}
        </p>

        <p className="mt-1.5 text-[28px] font-semibold leading-[1.15] tabular text-text">{value}</p>
        <p className="mt-0.5 text-[12px] text-text-3">{valueLabel}</p>

        <div className="mt-3 border-t border-border/60 pt-2">
          <p className="text-[15px] font-semibold leading-tight tabular text-text-2">{priorValue}</p>
          <p className="mt-0.5 text-[12px] text-text-3">{priorLabel}</p>
        </div>

        {context && <p className="mt-3 text-[13px] leading-snug tabular text-text-2">{context}</p>}
      </div>
    </Card>
  );
}
