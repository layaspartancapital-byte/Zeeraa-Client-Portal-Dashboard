import {
  channelCostPerDeal,
  channelMonthActuals,
  fundedTargetActuals,
  improvementDirectionFor,
  monthKeyOf,
  rampMonthKey,
  rampSeries,
  rampTimeline,
  rangeCoverage,
  scorecardVerdict,
  type ScorecardVerdict,
  type FundedTargetMetric,
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
  /**
   * One month of funded deals or volume as the funded targets measure them:
   * every source except lead vendors (`fundedTargetActuals`, 30 October 2026).
   * `monthActual` keeps the ramp channel's own, which carries no target now.
   */
  fundedTarget: (metric: FundedTargetMetric, month: string) => MonthActual;
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
  // A cost is never withheld for a small denominator; only an empty one has
  // no figure (see `packages/core/src/population.ts`).
  const gatedCost = (spend: number, attributed: number, _formulaKey: string) =>
    attributed > 0 ? channelCostPerDeal({ channelSpend: spend, attributedDeals: attributed }).value : null;
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

  // Not frozen: the freeze holds the ramp channel's six figures, and the
  // channel figures it holds carry no unattributed volume to rebuild this from.
  const fundedTarget = (metric: FundedTargetMetric, month: string): MonthActual => {
    const bucket = buckets.find((b) => monthKeyOf(b.start) === month);
    const dealsBySource = Object.fromEntries(
      Object.entries(bucket?.stagesByPlatform ?? {}).map(([source, stages]) => [source, valueKey ? (stages[valueKey] ?? 0) : 0]),
    );
    const volumeBySource = bucket?.valueVolumeByPlatform ?? {};
    const attributedVolume = Object.values(volumeBySource).reduce((sum, v) => sum + v, 0);
    return fundedTargetActuals(
      {
        dealsBySource,
        unattributedDeals: valueKey ? (bucket?.unattributedStages[valueKey] ?? 0) : 0,
        volumeBySource,
        unattributedVolume: (bucket?.valueVolume ?? 0) - attributedVolume,
        crmRead: bucket?.crmIngested ?? false,
      },
      { valueStage: valueKey },
    )[metric];
  };

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
    fundedTarget,
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
  /** Shown in place of a target where the figure carries none here. */
  untargeted?: string;
};

/**
 * The ramp channel's card. Funded deals and volume are its own and carry no
 * target: the funded targets are every source's except lead vendors', on the
 * All sources card (`fundedTargetRows`). CPA, cost per funded deal and spend
 * keep theirs, because Google spend is their numerator (30 October 2026).
 */
const SCORECARD: { metric: RampMetricKey; formulaKey: string; kind: 'rate' | 'count'; targeted: boolean }[] = [
  { metric: 'costPerFundedDeal', formulaKey: 'cost_per_funded_deal', kind: 'rate', targeted: true },
  { metric: 'cpa', formulaKey: 'cpa', kind: 'rate', targeted: true },
  { metric: 'fundedDeals', formulaKey: 'stage_count', kind: 'count', targeted: false },
  { metric: 'fundedAmount', formulaKey: 'funded_volume', kind: 'count', targeted: false },
  { metric: 'budget', formulaKey: 'paid_media_spend', kind: 'count', targeted: true },
];

const FUNDED_TARGET_ROWS: { metric: FundedTargetMetric; formulaKey: string; kind: 'count' }[] = [
  { metric: 'fundedDeals', formulaKey: 'stage_count', kind: 'count' },
  { metric: 'fundedAmount', formulaKey: 'funded_volume', kind: 'count' },
];

type ScorecardInput = { currentMonth: string; elapsed: number; metrics: Metrics; valueLabel: string };

/** This month's ramp month, and why there is no target where there is none. */
function thisRampMonth(panels: RampPanels, currentMonth: string) {
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
  return { start, rampMonth, beforeM1, noTarget };
}

function scorecardRow(
  panels: RampPanels,
  input: ScorecardInput,
  row: { metric: RampMetricKey; formulaKey: string; kind: 'rate' | 'count'; label: string; format: RampPanel['format'] },
  actual: MonthActual,
  untargeted?: string,
): ScorecardRow {
  const { start, rampMonth, beforeM1, noTarget } = thisRampMonth(panels, input.currentMonth);
  const raw = untargeted ? null : rampMonth?.[row.metric];
  const target = raw === null || raw === undefined ? null : Number(raw);
  const m1 = panels.targets.find((t) => t.monthIndex === 1)?.[row.metric];
  return {
    metric: row.metric,
    label: row.label,
    format: row.format,
    actual,
    target,
    upcoming: !untargeted && beforeM1 && m1 !== null && m1 !== undefined ? { month: start!, value: Number(m1) } : null,
    ...(untargeted ? { untargeted } : {}),
    verdict: scorecardVerdict({
      actual: actual.value,
      actualReason: actual.reason,
      target,
      noTarget: untargeted ?? noTarget ?? 'No target is recorded for this month.',
      direction: improvementDirectionFor(row.formulaKey),
      kind: row.kind,
      partial: true,
      elapsed: input.elapsed,
    }),
  };
}

const panelOf = (panels: RampPanels, metric: RampMetricKey) =>
  [panels.primary, panels.secondary, ...panels.compact].find((p) => p.metric === metric)!;

export function scorecardRows(panels: RampPanels, input: ScorecardInput): ScorecardRow[] {
  const { currentMonth, valueLabel } = input;
  const labels: Record<string, string> = {
    costPerFundedDeal: `Cost per ${valueLabel.toLowerCase()} deal`,
    cpa: 'CPA',
    fundedDeals: `${valueLabel} deals`,
    fundedAmount: `${valueLabel} volume`,
    budget: 'Spend',
  };
  return SCORECARD.map(({ metric, formulaKey, kind, targeted }) =>
    scorecardRow(
      panels,
      input,
      { metric, formulaKey, kind, label: labels[metric]!, format: panelOf(panels, metric).format },
      panels.monthActual(metric, currentMonth),
      targeted ? undefined : 'Targeted across all sources',
    ),
  );
}

/**
 * The funded targets for this month, against every source except lead
 * vendors: the All sources card's half of the ramp (30 October 2026).
 */
export function fundedTargetRows(panels: RampPanels, input: ScorecardInput): ScorecardRow[] {
  const { currentMonth, valueLabel } = input;
  const labels: Record<FundedTargetMetric, string> = {
    fundedDeals: `${valueLabel} deals`,
    fundedAmount: `${valueLabel} volume`,
  };
  return FUNDED_TARGET_ROWS.map(({ metric, formulaKey, kind }) =>
    scorecardRow(
      panels,
      input,
      { metric, formulaKey, kind, label: labels[metric], format: panelOf(panels, metric).format },
      panels.fundedTarget(metric, currentMonth),
    ),
  );
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

/**
 * The engagement ramp as one table (24 September 2026, replacing five charts
 * on Monthly performance): a row per month, the baseline months first with
 * actuals only, then M1–Mn with each figure against its target.
 *
 * Every cell's verdict is `scorecardVerdict`, the executive scorecard's rule,
 * so a month cannot read "on target" on one screen and "behind" on the other:
 * a finished month against its target, the month in progress against pace.
 * A month that has not happened shows its target and nothing else.
 */
export type RampTableColumn = {
  key: string;
  metric: RampMetricKey;
  label: (valueLabel: string) => string;
  formulaKey: string;
  kind: 'rate' | 'count';
  /**
   * `channel`: the ramp channel's own figure. `funded`: the funded targets'
   * measure, every source except lead vendors (30 October 2026).
   */
  scope: 'channel' | 'funded';
  /** False where the figure is shown without its target. */
  targeted: boolean;
};

export const RAMP_TABLE_COLUMNS: RampTableColumn[] = [
  { key: 'budget', metric: 'budget', label: () => 'Spend', formulaKey: 'paid_media_spend', kind: 'count', scope: 'channel', targeted: true },
  { key: 'approvals', metric: 'approvals', label: () => 'Approvals', formulaKey: 'stage_count', kind: 'count', scope: 'channel', targeted: true },
  { key: 'cpa', metric: 'cpa', label: () => 'CPA', formulaKey: 'cpa', kind: 'rate', scope: 'channel', targeted: true },
  { key: 'fundedDeals', metric: 'fundedDeals', label: (v) => `${v}`, formulaKey: 'stage_count', kind: 'count', scope: 'channel', targeted: false },
  { key: 'costPerFundedDeal', metric: 'costPerFundedDeal', label: (v) => `Cost per ${v.toLowerCase()}`, formulaKey: 'cost_per_funded_deal', kind: 'rate', scope: 'channel', targeted: true },
  { key: 'allFundedDeals', metric: 'fundedDeals', label: (v) => `${v}, all sources`, formulaKey: 'stage_count', kind: 'count', scope: 'funded', targeted: true },
  { key: 'allFundedAmount', metric: 'fundedAmount', label: (v) => `${v} volume, all sources`, formulaKey: 'funded_volume', kind: 'count', scope: 'funded', targeted: true },
];

export type RampTableCell = {
  actual: MonthActual | null;
  target: number | null;
  verdict: ScorecardVerdict | null;
};

export type RampTableRow = {
  month: string;
  /** `M3`, or null for a baseline month. */
  rampLabel: string | null;
  inProgress: boolean;
  future: boolean;
  /** Keyed by `RampTableColumn.key`. */
  cells: Record<string, RampTableCell>;
};

export function rampTableRows(
  panels: RampPanels,
  input: { currentMonth: string; elapsed: number },
): RampTableRow[] {
  const timeline = panels.primary.timeline;
  if (!timeline) return [];
  return timeline.points.map((point) => {
    const future = point.month > input.currentMonth;
    const inProgress = point.month === input.currentMonth;
    const target = point.monthIndex === null ? null : (panels.targets.find((t) => t.monthIndex === point.monthIndex) ?? null);
    const cells = Object.fromEntries(
      RAMP_TABLE_COLUMNS.map(({ key, metric, formulaKey, kind, scope, targeted }) => {
        const raw = targeted ? target?.[metric] : null;
        const targetValue = raw === null || raw === undefined ? null : Number(raw);
        const actual = future
          ? null
          : scope === 'funded'
            ? panels.fundedTarget(metric as FundedTargetMetric, point.month)
            : panels.monthActual(metric, point.month);
        const verdict =
          point.monthIndex === null || future || targetValue === null
            ? null
            : scorecardVerdict({
                actual: actual?.value ?? null,
                actualReason: actual?.reason ?? null,
                target: targetValue,
                noTarget: null,
                direction: improvementDirectionFor(formulaKey),
                kind,
                partial: inProgress,
                elapsed: inProgress ? input.elapsed : 1,
              });
        return [key, { actual, target: targetValue, verdict }];
      }),
    ) as Record<string, RampTableCell>;
    return {
      month: point.month,
      rampLabel: point.monthIndex === null ? null : `M${point.monthIndex}`,
      inProgress,
      future,
      cells,
    };
  });
}
