import {
  briefingPeriods,
  canAdministerTenant,
  channelCostPerDeal,
  formatCount,
  formatCurrency,
  formatDuration,
  formatRangeLabel,
  formatRate,
  previousRange,
  rangeLengthDays,
  trailingMonths,
  type AttributionModel,
} from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine, Grid } from '@/components/ui/Card';
import { NotMeasuredBadge } from '@/components/ui/Badge';
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
import { RampCostChart, RampScorecard } from '@/components/ExecutiveRamp';
import { monthName } from '@/components/RampCard';
import { buildRampPanels, scorecardRows } from '@/lib/ramp-panels';
import { SourceFreshness } from '@/components/SourceFreshness';
import { callReport, monthlyPerformance } from '@/lib/reporting';
import { platformLabel as platformName } from '@/lib/platform-labels';
import {
  alowareConnectedThreshold,
  connectionHealth,
  dataQuality,
  engagementRamp,
  frozenBaseline,
  loadMetrics,
  pausedCampaigns,
  sourceFreshness,
  windowBuckets,
} from '@/lib/dashboard';
import { requireTenant } from '@/lib/tenant';
import {
  coverageFor,
  isUnmeasured,
  notMeasuredReason,
  sourcesThrough,
  throughNote,
} from '@/lib/coverage';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { rangeLinks, rangeParams, resolvePageRange, type RangeQuery } from '@/lib/range';
import { Download } from 'lucide-react';

export async function generateMetadata({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const { tenant } = await requireTenant(slug);
  return { title: { absolute: `${tenant.name} · Executive briefing` } };
}

/**
 * How long a render may be reused: ten minutes, the Salesforce sync
 * (`/api/cron/salesforce`). `AutoRefresh` runs the client half on the same
 * cadence, so a tab left open all afternoon does not sit on a morning render.
 */
export const revalidate = 600;

/**
 * The executive briefing.
 *
 * **Month to date by default, and any range on request** (23 September 2026).
 * It had no date control at all; the client asked for the same
 * `DateRangePicker` every other screen has, and the rules that made a
 * control-free briefing safe carry over unchanged:
 *
 *   * **the ramp** covers the engagement and its baseline, on the calendar once M1 is set, and never reads
 *     the picked range — a contracted month is a completed calendar month, and
 *     the ramp's actuals come from its own twelve monthly buckets;
 *   * **every measured figure** covers the picked range, with a comparison
 *     beside it: the last whole month while the range is month to date, and
 *     otherwise the period of the same length immediately before;
 *   * **the scorecard** is this calendar month's, whatever is picked, because a
 *     target is contracted per month;
 *   * **the findings** are current state, and not a period at all.
 *
 * A *count* in one period is never subtracted from a count in the other —
 * month to date against a whole month is mostly a difference in calendar days
 * — so those sit as two figures. Rates and costs do compare. Every ratio is
 * gated on its own denominator, so a one-day range withholds a cost per funded
 * deal rather than dividing by one.
 *
 * It serves two readers at once, which is what decides the contents. Spartan's
 * leadership get the commitment, the funnel and what needs doing. Zeeraa's team
 * get the coverage under every figure, the data-quality card, and the findings
 * that are theirs to close — a paused campaign, a degraded connector, a stage
 * nobody stamps.
 */
export default async function ExecutiveBriefing({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<RangeQuery>;
}) {
  const { tenant: slug } = await params;
  const query = await searchParams;
  const session = await requireTenant(slug);
  // Zeeraa staff see the data-quality working list; a client does not.
  const staff = canAdministerTenant(session.tenant.role);
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

  /*
   * Month to date unless a range is asked for. The resolver's own default is
   * the last 90 days, which is right for the analysis screens and wrong for a
   * briefing, so an unscoped visit asks for `mtd` explicitly.
   */
  const scoped = Boolean(query.from || query.to || query.preset || query.days);
  const page = await resolvePageRange(session, scoped ? query : { preset: 'mtd' });
  const { today, range, preset, problem, earliest } = page;
  const periods = briefingPeriods(today);
  const { lastFullMonth } = periods;
  const isMonthToDate =
    range.start === periods.monthToDate.start && range.end === periods.monthToDate.end;
  const comparison = isMonthToDate ? lastFullMonth : previousRange(range);
  const { preserve, presetHref } = rangeLinks(`/${slug}`, {});

  const connectedThreshold = await alowareConnectedThreshold(session);

  const [
    current,
    previous,
    buckets,
    metrics,
    quality,
    ramp,
    frozenAll,
    calls,
    connections,
    paused,
    freshness,
    through,
  ] = await Promise.all([
    monthlyPerformance(session, range, model),
    monthlyPerformance(session, comparison, model),
    // Twelve monthly buckets, which serve both the mini charts and the ramp's
    // actuals: the ramp needs one figure per calendar month, and this is
    // already one figure per calendar month, per channel.
    windowBuckets(session, trailingMonths(today, 12), 'month', model),
    loadMetrics(session),
    dataQuality(session),
    engagementRamp(session),
    frozenBaseline(session),
    callReport(session, range, connectedThreshold),
    connectionHealth(session),
    pausedCampaigns(session, lastFullMonth.start),
    sourceFreshness(session),
    sourcesThrough(session),
  ]);

  const valueStage = current.stages.find((s) => s.countsValue);
  const valueKey = valueStage?.key ?? null;
  const valueLabel = valueStage?.label ?? 'Funded';

  const dealsIn = (stages: Record<string, number>) => (valueKey ? (stages[valueKey] ?? 0) : 0);
  const attributedDeals = (source: typeof current) =>
    source.channels.reduce((sum, c) => sum + dealsIn(c.stages), 0);

  /* ----------------------------------------------------------------------- */
  /* Coverage: how much of the range each source has actually been synced for */
  /* ----------------------------------------------------------------------- */

  /**
   * A range past the last sync is not a quiet period.
   *
   * Picked for a day Salesforce has not been read since, every CRM figure
   * here came back 0 — no deals, no leads, no funnel — which is a measurement
   * claiming nothing happened. Each source's coverage of the range is worked
   * out from its last successful read: nothing synced renders the named
   * `Not measured` state, and a range that runs past the last sync says where
   * its figures stop.
   */
  const cover = coverageFor(through, range);
  const crmCoverage = cover.crm;
  // The comparison beside a figure is a figure too, and can be just as unsynced.
  const crmPriorCoverage = cover.of('salesforce', comparison);
  const spendCoverage = cover.spend;
  const callCoverage = cover.calls;

  const crmUnmeasured = isUnmeasured(crmCoverage);
  const crmNote = throughNote(crmCoverage, 'Salesforce');
  const spendNote = throughNote(spendCoverage, 'paid media');

  const mtdLabel = isMonthToDate
    ? `${formatRangeLabel(range)} · month to date`
    : formatRangeLabel(range);
  const lastMonthLabel = isMonthToDate
    ? formatRangeLabel(lastFullMonth)
    : rangeLengthDays(comparison) === 1
      ? `${formatRangeLabel(comparison)} · the day before`
      : `${formatRangeLabel(comparison)} · the ${formatCount(rangeLengthDays(comparison))} days before`;

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
  /*
   * The ramp's panels and months, built once (`lib/ramp-panels.ts`) so this
   * screen and Monthly performance read the same months the same way. The
   * baseline starts where the ramp channel's spend record does.
   */
  const rampPanels = buildRampPanels({
    buckets,
    metrics,
    ramp,
    frozen: frozenAll,
    through,
    valueKey,
    valueLabel,
    currency,
    currentMonth: periods.currentMonth,
  });
  const rampPlatform = rampPanels.platform;
  const rampChannel = rampPanels.channel;
  const scorecard = scorecardRows(rampPanels, {
    currentMonth: periods.currentMonth,
    elapsed: periods.elapsed,
    metrics,
    valueLabel,
  });

  // The scorecard is this calendar month whatever range is picked, so its
  // sources are asked about this month: Google Ads for spend and costs,
  // Salesforce for the deals and approvals.
  const scorecardNote =
    throughNote(cover.of(rampPlatform, periods.monthToDate), rampChannel) +
    throughNote(cover.of('salesforce', periods.monthToDate), 'Salesforce');

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
        // Never withheld for a small denominator: the cell shows what it
        // divided by instead ("1 deal"), and the reader weighs it.
        return { stage: column.stage, cost };
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

  const callsMeasured = !isUnmeasured(callCoverage) && !crmUnmeasured;
  if (callsMeasured && speedGate.sufficient && calls.speed.medianSeconds !== null) {
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
        } reached within five minutes · ${calls.clock}` +
        (calls.businessHours
          ? ` · 24/7 median ${formatDuration(calls.speedAllHours.medianSeconds)}`
          : ''),
      note: 'Measured only over leads that were called — a lead nobody rang has no response time and is not counted as a slow one. Five minutes is the industry bar, not one this product sets.',
      action: { label: 'Funnel', href: `/${slug}/funnel` },
    });
  }

  if (callsMeasured && !calls.empty) {
    findings.push({
      key: 'call-volume',
      level: 'watch',
      headline: isMonthToDate ? 'Calls this month' : 'Calls in this range',
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

  /*
   * A pushed source that has stopped delivering.
   *
   * It has no failed run to appear in `degraded` — nothing ran, because
   * nothing is pulled — so without this it shows up as a slightly old
   * timestamp and nothing else. Spartan's call webhook had delivered exactly
   * nothing since the historical import, against a desk doing several hundred
   * calls a day, and the briefing said "last call 4d 22h ago" in the same grey
   * as every healthy source.
   */
  for (const source of freshness) {
    if (source.arrival !== 'webhook' || source.typicalPerDay === null) continue;
    if (source.typicalPerDay < 1) continue;
    const ageHours = source.at === null ? null : (Date.now() - source.at.getTime()) / 3_600_000;
    if (ageHours !== null && ageHours <= 24) continue;
    findings.push({
      key: `silent-${source.platform}`,
      level: 'act',
      headline: `${source.label} has stopped delivering`,
      figure:
        ageHours === null ? 'nothing received' : `${Math.round(ageHours / 24)}d silent`,
      detail:
        `pushed by webhook, so there is no failed sync to look at · was arriving at about ` +
        `${formatCount(Math.round(source.typicalPerDay))} a day`,
      note: 'This source is pushed rather than pulled, so a gap is not a sync failure and will not appear on the connections screen as one. Check that the webhook subscription still points at this deployment and that its secret is set.',
      action: { label: 'Connections', href: `/${slug}/connections` },
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

  if (!crmUnmeasured && unattributedDeals > 0) {
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
        'The scorecard is always this calendar month, and the cost per deal chart covers the ' +
        'engagement; neither reads the picked range. Every other figure covers the picked range.',
      detail:
        `The range is ${mtdLabel}, compared with ${lastMonthLabel}. A count from one is never ` +
        'subtracted from a count in the other, so those sit as two figures. Rates and costs do ' +
        'compare. A cost always shows its number with how many it was based on.',
    },
    {
      heading: 'This month vs target',
      body:
        `Each figure is ${rampChannel} alone: its spend, and the deals and approvals attributed to it. ` +
        'The target is the engagement model’s figure for this month of the ramp.',
      detail:
        'A month in progress is judged against pace — a count or a spend against the target times the share ' +
        'of the month gone, a cost as it stands once it has enough deals under it. Within 5% of target is on ' +
        'target; spend is stated as over or under, never as behind.',
    },
    {
      heading: `${rampChannel} cost per ${valueLabel.toLowerCase()} deal, by month`,
      body:
        ramp.startMonth === null
          ? 'The contract commits a figure for each month of the engagement; until the start month is recorded the curve is drawn on an M1–M8 axis.'
          : `The months before M1 (${monthName(ramp.startMonth)}) are the baseline, from the first month ${rampChannel} spend was read; the dashed line is the contracted target.`,
      detail:
        'A solid point is a finished month. The hollow point is the month so far, never compared with a target. ' +
        'A month with too few deals, or with days its source was not read, is left as a gap; hover it for why.',
    },
    {
      heading: 'CPA',
      body: `${rampChannel} spend divided by the UW approvals attributed to ${rampChannel} — cost per approval.`,
      detail: 'The full CPA, approvals, budget and volume curves are on Monthly performance.',
    },
    {
      heading: 'Cost per stage',
      body:
        'Each figure is one channel’s spend over the records attributed to that channel at that ' +
        'stage. Nothing here is blended across channels.',
      detail:
        'Under each cost is the number it was divided by. A cost over one or two deals can move a lot when the next one lands.',
    },
    {
      heading: 'How current these figures are',
      body:
        'Salesforce is pulled every ten minutes and the ad platforms hourly, so a figure covering ' +
        'today reaches only as far as the last run. Calls are pushed by webhook as each one ends, ' +
        'and this page refetches itself every ten minutes while it is open.',
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
      )} ${valueLabel.toLowerCase()} deals in ${mtdLabel}.`,
    },
    ...(staff ? quality : []).map((item) => ({
      heading: item.name,
      body: item.detail || item.summary,
      detail: item.since ? `Outstanding since ${item.since.toISOString().slice(0, 10)}.` : undefined,
    })),
  ];

  const exportParams = new URLSearchParams({ ...rangeParams(range), model });

  return (
    <>
      <TopBar tenant={session.tenant} viewer={session.viewer} title="Executive briefing">
        <DateRangePicker
          range={range}
          preset={preset}
          presetHref={presetHref}
          preserve={preserve}
          problem={problem}
          earliest={earliest}
          today={today}
        />
        <ButtonLink href={`/api/export/${slug}/performance?${exportParams.toString()}`}>
          <Download aria-hidden="true" className="h-4 w-4" />
          Export CSV
        </ButtonLink>
        <PrintButton />
        {/*
          Every connected platform, not just Google Ads.
          This button was scoped to `google_ads`, so on a briefing that reports
          two channels it refreshed one and reported "succeeded" — truthfully,
          about the half it ran. `runIncrementalSync` takes every platform when
          none is named, which is what a button on a whole-engagement screen
          should do. The connections screen keeps its per-platform buttons.
        */}
        {canAdministerTenant(session.tenant.role) && <SyncNowButton slug={slug} />}
      </TopBar>

      <PageMeta>
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <SourceFreshness
            sources={freshness}
            now={new Date()}
            timezone={session.tenant.timezone}
            includesToday
          />
          <AutoRefresh />
        </span>
        <MethodDrawer
          notes={notes}
          title={`Executive briefing · ${mtdLabel}`}
        />
      </PageMeta>

      <Grid>
        {/* 1. The commitment: this month against it, and the one curve a
            client is judged on. The other curves are on Monthly performance. */}
        <RampScorecard
          channel={rampChannel}
          rows={scorecard}
          monthLabel={monthName(periods.currentMonth)}
          elapsedDays={periods.elapsedDays}
          monthDays={periods.monthDays}
          currency={currency}
          note={scorecardNote}
        />
        <RampCostChart panel={rampPanels.primary} />

        {/* 2. The outcome, and the spend that bought it. */}
        <TwoPeriodKpi
          span={6}
          label={`${valueLabel} deals`}
          value={formatCount(totalDeals)}
          notMeasured={crmUnmeasured ? notMeasuredReason(crmCoverage, 'Salesforce') : undefined}
          priorValue={
            isUnmeasured(crmPriorCoverage)
              ? NOT_MEASURED
              : formatCount(dealsIn(previous.total.stages))
          }
          valueLabel={`${mtdLabel}${crmNote}`}
          priorLabel={lastMonthLabel}
          context={
            crmUnmeasured
              ? undefined
              : `${formatCount(attributedDeals(current))} attributed · ${formatCount(
                  unattributedDeals,
                )} to no channel`
          }
          info="Deals reaching the value stage, renewals excluded. Shown for both periods and never subtracted: a count's difference is mostly the calendar."
        />
        <TwoPeriodKpi
          span={6}
          label={`${valueLabel} volume`}
          value={formatCurrency(current.total.valueVolume, currency)}
          notMeasured={crmUnmeasured ? notMeasuredReason(crmCoverage, 'Salesforce') : undefined}
          priorValue={
            isUnmeasured(crmPriorCoverage)
              ? NOT_MEASURED
              : formatCurrency(previous.total.valueVolume, currency)
          }
          valueLabel={`${mtdLabel}${crmNote}`}
          priorLabel={lastMonthLabel}
          context="Every source, attributed or not"
          info="The funded amount on every deal reaching the value stage, from any source. Not a channel figure: no spend is divided into it."
        />

        {/* 3. The funnel, every stage and the rate between each pair. */}
        <Card span={12}>
          <CardHeader
            title="Funnel"
            subtitle={`Every stage and the conversion between them · ${mtdLabel}${crmNote}`}
          />
          {crmUnmeasured ? (
            <CardBody>
              <EmptyLine action={<NotMeasuredBadge />}>{notMeasuredReason(crmCoverage, 'Salesforce')}</EmptyLine>
            </CardBody>
          ) : (
            <FunnelStages
              data={current}
              counts={current.total.stages}
              populationLabel="every source"
            />
          )}
        </Card>

        {/* 4. What each stage costs, per channel. */}
        {crmUnmeasured || isUnmeasured(spendCoverage) ? (
          <Card span={12}>
            <CardHeader
              title="Efficiency"
              subtitle={`What each stage costs, per channel · ${mtdLabel}`}
            />
            <CardBody>
              <EmptyLine action={<NotMeasuredBadge />}>
                {crmUnmeasured ? notMeasuredReason(crmCoverage, 'Salesforce') : notMeasuredReason(spendCoverage, 'Paid media')}
              </EmptyLine>
            </CardBody>
          </Card>
        ) : (
          <EfficiencyTable
            rows={efficiencyRows}
            columns={efficiencyColumns}
            unattributed={{
              label: current.unattributed.label,
              reason: current.unattributed.reason,
              counts: current.unattributed.stages,
            }}
            currency={currency}
            periodLabel={`${mtdLabel}${crmNote}${spendNote}`}
          />
        )}

        {/* 5. What to do about it, and what the platform cannot say. */}
        {/* Data quality is Zeeraa's working list, not the client's: a client
            reads a list of what cannot be measured as a list of failures. */}
        <NeedsAttention findings={findings} span={staff ? 8 : 12} />
        {staff && <DataQualityCard items={quality} span={4} />}
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

/** The comparison's named state; a sentinel so it can never be formatted as a number. */
const NOT_MEASURED = 'Not measured';

function TwoPeriodKpi({
  label,
  value,
  priorValue,
  valueLabel,
  priorLabel,
  context,
  info,
  notMeasured,
  span = 3,
}: {
  label: string;
  value: string;
  /** Why this period cannot be counted. Rendered as the named state, never 0. */
  notMeasured?: string;
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

        {notMeasured ? (
          <div className="mt-2">
            <NotMeasuredBadge />
            <p className="mt-1.5 text-[12px] leading-snug text-text-3">{notMeasured}</p>
          </div>
        ) : (
          <p className="mt-1.5 text-[28px] font-semibold leading-[1.15] tabular text-text">{value}</p>
        )}
        <p className="mt-0.5 text-[12px] text-text-3">{valueLabel}</p>

        <div className="mt-3 border-t border-border/60 pt-2">
          {priorValue === NOT_MEASURED ? (
            <NotMeasuredBadge />
          ) : (
            <p className="text-[15px] font-semibold leading-tight tabular text-text-2">{priorValue}</p>
          )}
          <p className="mt-0.5 text-[12px] text-text-3">{priorLabel}</p>
        </div>

        {context && <p className="mt-3 text-[13px] leading-snug tabular text-text-2">{context}</p>}
      </div>
    </Card>
  );
}
