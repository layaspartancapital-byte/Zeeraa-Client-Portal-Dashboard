import {
  channelCostPerDeal,
  channelMonthActuals,
  improvementDirectionFor,
  monthKeyOf,
  rampMonthKey,
  rampSeries,
  rampTimeline,
  rangeCoverage,
  scorecardVerdict,
  type ScorecardVerdict,
  type MonthActual,
  type RampMetricKey,
  type RampTarget,
} from '@zeeraa/core';
import type { RampPanel } from '@/components/RampCard';
import type { FrozenMonth, Metrics, WindowBucket, EngagementRamp } from '@/lib/dashboard';
import type { SourcesThrough } from '@/lib/coverage';
import { platformLabel } from '@/lib/platform-labels';

/**
 * The engagement ramp's panels, built once for every screen that draws them.
 *
 * The executive screen draws a four-card scorecard and one chart, cost per
 * funded deal; Monthly performance draws CPA, budget, approvals, funded deals
 * and funded volume as full charts. Both read the same months through `channelMonthActuals`, and a
 * frozen month from its snapshot, so the two screens cannot disagree about a
 * month.
 */
export type RampPanels = {
  platform: string;
  channel: string;
  startMonth: string | null;
  targets: RampTarget[];
  primary: RampPanel;
  secondary: RampPanel;
  /** Budget, approvals, funded deals, funded volume. */
  compact: RampPanel[];
  /** One month of any contracted metric, frozen or live. */
  monthActual: (metric: RampMetricKey, month: string) => MonthActual;
};

/** Never more baseline than this before M1, however long the record. */
const MAX_BASELINE_MONTHS = 6;

export function buildRampPanels(input: {
  buckets: WindowBucket[];
  metrics: Metrics;
  ramp: EngagementRamp;
  frozen: Map<string, FrozenMonth>;
  through: SourcesThrough;
  valueKey: string | null;
  valueLabel: string;
  currency: string;
  currentMonth: string;
}): RampPanels {
  const { buckets, metrics, ramp, frozen: frozenAll, through, valueKey, valueLabel, currency, currentMonth } = input;
  const platform = [...ramp.byPlatform.keys()][0] ?? 'google_ads';
  const targets = ramp.byPlatform.get(platform) ?? [];
  const channel = platformLabel(platform);

  /*
   * The baseline begins where the channel's spend record does: before it
   * there is nothing to measure, and months drawn only to say "not measured"
   * are clutter, not evidence. Six months at most.
   */
  const baselineMonths = (() => {
    if (!ramp.startMonth) return 0;
    // The ledger's first read; failing that, the first month with spend
    // stored. With neither, the channel has no record and no baseline.
    const first =
      through.from?.[platform] ??
      buckets.find((b) => (b.spendByPlatform[platform] ?? 0) > 0)?.start ??
      null;
    if (!first) return 0;
    const firstMonth = monthKeyOf(first);
    const months =
      (Number(ramp.startMonth.slice(0, 4)) - Number(firstMonth.slice(0, 4))) * 12 +
      (Number(ramp.startMonth.slice(5, 7)) - Number(firstMonth.slice(5, 7)));
    return Math.max(0, Math.min(MAX_BASELINE_MONTHS, months));
  })();

  // Only a finished month is a point on the M-axis curve (no start recorded).
  const completedBucketFor = (month: string) =>
    month >= currentMonth ? null : (buckets.find((b) => monthKeyOf(b.start) === month) ?? null);
  const gatedCost = (spend: number, attributed: number, formulaKey: string) =>
    metrics.population(formulaKey, attributed).sufficient
      ? channelCostPerDeal({ channelSpend: spend, attributedDeals: attributed }).value
      : null;
  const mAxisActual: Record<RampMetricKey, (month: string) => number | null> = {
    costPerFundedDeal: (month) => {
      const b = completedBucketFor(month);
      if (!b || !b.spendIngested || !valueKey) return null;
      return gatedCost(b.spendByPlatform[platform] ?? 0, b.stagesByPlatform[platform]?.[valueKey] ?? 0, 'cost_per_funded_deal');
    },
    cpa: (month) => {
      const b = completedBucketFor(month);
      if (!b || !b.spendIngested) return null;
      return gatedCost(b.spendByPlatform[platform] ?? 0, b.stagesByPlatform[platform]?.uw_approved ?? 0, 'cpa');
    },
    budget: (month) => {
      const b = completedBucketFor(month);
      return b?.spendIngested ? (b.spendByPlatform[platform] ?? 0) : null;
    },
    approvals: (month) => {
      const b = completedBucketFor(month);
      return b?.crmIngested ? (b.stagesByPlatform[platform]?.uw_approved ?? 0) : null;
    },
    fundedDeals: (month) => {
      const b = completedBucketFor(month);
      return b?.crmIngested && valueKey ? (b.stagesByPlatform[platform]?.[valueKey] ?? 0) : null;
    },
    fundedAmount: (month) => {
      const b = completedBucketFor(month);
      return b?.crmIngested && valueKey ? (b.valueVolumeByPlatform[platform] ?? 0) : null;
    },
  };

  const frozen = new Map(
    [...frozenAll]
      .filter(([key]) => key.startsWith(`${platform}|`))
      .map(([key, value]) => [key.slice(platform.length + 1), value]),
  );
  const liveMonth = (month: string): Record<RampMetricKey, MonthActual> => {
    const bucket = buckets.find((b) => monthKeyOf(b.start) === month);
    const stage = (key: string) => ({
      own: bucket?.stagesByPlatform[platform]?.[key] ?? 0,
      unattributed: bucket?.unattributedStages[key] ?? 0,
      all: bucket?.stages[key] ?? 0,
    });
    return channelMonthActuals(
      {
        spend: bucket?.spendByPlatform[platform] ?? 0,
        stages: { uw_approved: stage('uw_approved'), ...(valueKey ? { [valueKey]: stage(valueKey) } : {}) },
        ownVolume: bucket?.valueVolumeByPlatform[platform] ?? 0,
        spendCoverage:
          bucket?.spendCoverage[platform] ?? rangeCoverage({ start: `${month}-01`, end: `${month}-01` }, null),
        crmRead: bucket?.crmIngested ?? false,
      },
      {
        month,
        currentMonth,
        channel,
        valueStage: valueKey,
        approvalStage: 'uw_approved',
        renderFloor: metrics.floors.render,
      },
    );
  };
  const monthActual = (metric: RampMetricKey, month: string): MonthActual =>
    frozen.get(`${month}|${metric}`) ?? liveMonth(month)[metric];

  const panelFor = (
    metric: RampMetricKey,
    label: string,
    formulaKey: string,
    format: RampPanel['format'],
    missing: string,
    basis: string,
  ): RampPanel => {
    // The direction comes from the formula, as every delta's does.
    const direction = improvementDirectionFor(formulaKey);
    return {
      metric,
      label,
      format,
      direction,
      missing,
      series: rampSeries(targets, metric, { startMonth: ramp.startMonth, actualFor: mAxisActual[metric], direction }),
      channel,
      basis,
      timeline:
        ramp.startMonth === null
          ? null
          : rampTimeline(targets, metric, {
              startMonth: ramp.startMonth,
              baselineMonths,
              currentMonth,
              readActual: (month) => monthActual(metric, month),
              direction,
            }),
    };
  };

  const AWAITING =
    'The engagement model contracts this month by month. The figures have not been entered in the engagement targets yet.';
  const deals = `${valueLabel.toLowerCase()} deals`;
  const money = { kind: 'currency', currency } as const;

  return {
    platform,
    channel,
    startMonth: ramp.startMonth,
    targets,
    primary: panelFor('costPerFundedDeal', `Cost per ${valueLabel.toLowerCase()} deal`, 'cost_per_funded_deal', money, AWAITING, `${channel} spend ÷ ${deals} attributed to ${channel}`),
    secondary: panelFor('cpa', 'CPA · cost per approval', 'cpa', money, AWAITING, `${channel} spend ÷ UW approvals attributed to ${channel}`),
    compact: [
      panelFor('budget', 'Budget', 'paid_media_spend', money, 'Only M1 of the budget curve has been entered.', `${channel} spend`),
      panelFor('approvals', 'Approvals', 'stage_count', { kind: 'projection' }, AWAITING, `UW approvals attributed to ${channel}`),
      panelFor('fundedDeals', `${valueLabel} deals`, 'stage_count', { kind: 'projection' }, AWAITING, `${valueLabel} deals attributed to ${channel}`),
      panelFor('fundedAmount', `${valueLabel} volume`, 'funded_volume', money, AWAITING, `${valueLabel} volume attributed to ${channel}`),
    ],
    monthActual,
  };
}

/**
 * One card of the executive scorecard: this month's figure for one contracted
 * metric, its target, and the verdict.
 *
 * The verdict is `scorecardVerdict` in core, so "on target" means one thing:
 * a month in progress is judged against pace for a count or a spend, and as it
 * stands for a cost, above its comparison floor. Before M1 there is no target
 * this month, and the card names M1's instead of inventing one.
 */
export type ScorecardRow = {
  metric: RampMetricKey;
  label: string;
  format: RampPanel['format'];
  actual: MonthActual;
  target: number | null;
  verdict: ScorecardVerdict;
  /** Before M1: the first contracted figure and the month it applies to. */
  upcoming: { month: string; value: number } | null;
};

const SCORECARD: { metric: RampMetricKey; formulaKey: string; kind: 'rate' | 'count' }[] = [
  { metric: 'costPerFundedDeal', formulaKey: 'cost_per_funded_deal', kind: 'rate' },
  { metric: 'cpa', formulaKey: 'cpa', kind: 'rate' },
  { metric: 'fundedDeals', formulaKey: 'stage_count', kind: 'count' },
  { metric: 'budget', formulaKey: 'paid_media_spend', kind: 'count' },
];

export function scorecardRows(
  panels: RampPanels,
  input: { currentMonth: string; elapsed: number; metrics: Metrics; valueLabel: string },
): ScorecardRow[] {
  const { currentMonth, elapsed, metrics, valueLabel } = input;
  const start = panels.startMonth;
  const rampMonth =
    start === null
      ? null
      : (panels.targets.find((t) => rampMonthKey(start, t.monthIndex) === currentMonth) ?? null);
  const beforeM1 = start !== null && currentMonth < start;
  const noTarget =
    start === null
      ? 'The engagement start month is not recorded.'
      : beforeM1
        ? `Targets begin ${monthLabelOf(start)}.`
        : rampMonth === null
          ? 'This month is past the contracted ramp.'
          : null;
  const labels: Record<string, string> = {
    costPerFundedDeal: `Cost per ${valueLabel.toLowerCase()} deal`,
    cpa: 'CPA',
    fundedDeals: `${valueLabel} deals`,
    budget: 'Spend',
  };
  const panelOf = (metric: RampMetricKey) =>
    [panels.primary, panels.secondary, ...panels.compact].find((p) => p.metric === metric)!;

  return SCORECARD.map(({ metric, formulaKey, kind }) => {
    const panel = panelOf(metric);
    const actual = panels.monthActual(metric, currentMonth);
    const raw = rampMonth?.[metric];
    const target = raw === null || raw === undefined ? null : Number(raw);
    const m1 = panels.targets.find((t) => t.monthIndex === 1)?.[metric];
    return {
      metric,
      label: labels[metric]!,
      format: panel.format,
      actual,
      target,
      upcoming: beforeM1 && m1 !== null && m1 !== undefined ? { month: start!, value: Number(m1) } : null,
      verdict: scorecardVerdict({
        actual: actual.value,
        actualReason: actual.reason,
        target,
        noTarget: noTarget ?? 'No target is recorded for this month.',
        direction: improvementDirectionFor(formulaKey),
        kind,
        partial: true,
        elapsed,
        comparable: actual.cost ? metrics.comparable(formulaKey, actual.cost.attributedDeals) : undefined,
      }),
    };
  });
}

/** `Oct 2026`, from `2026-10`. */
function monthLabelOf(month: string): string {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year!, m! - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
