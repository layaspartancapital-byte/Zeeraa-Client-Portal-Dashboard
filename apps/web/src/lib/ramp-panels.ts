import {
  channelCostPerDeal,
  channelMonthActuals,
  contractMonthActuals,
  contractRampTargets,
  contractTarget,
  improvementDirectionFor,
  isPaidChannel,
  monthKeyOf,
  rampMonthKey,
  rampSeries,
  rampTimeline,
  rangeCoverage,
  scorecardVerdict,
  type ScorecardVerdict,
  type ContractMetric,
  type ContractMonthInput,
  type ContractMonthMetric,
  type ContractTarget,
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
 * Two halves (30 October 2026). **The contract** — every target on screen,
 * from the signed contract (`contract_targets`), measured across sources:
 * cost per acquisition and cost per funded deal over every source, funded
 * volume over every source but lead vendors (`contractMonthActuals`). Executive's
 * All sources card, its cost per funded deal chart and Monthly performance's
 * ramp table read it. **The ramp channel** (Google Ads) — its own figures,
 * untargeted, on Executive's Google Ads card, read through
 * `channelMonthActuals` and a frozen month from its snapshot, as the baseline
 * check holds them.
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
  contract: ContractPanels;
};

export type ContractPanels = {
  /** Where the targets come from ("Zeeraa proposal, page 22"), or null with none recorded. */
  source: string | null;
  /** Cost per funded deal across every source, against the contract: the Executive chart. */
  primary: RampPanel;
  panels: Record<ContractMonthMetric, RampPanel>;
  /** One month, as the contract measures it: from the frozen channel figures where frozen, else live. */
  monthActual: (metric: ContractMonthMetric, month: string) => MonthActual;
  /** The contract's target for a calendar month; null for a metric it sets none for. */
  target: (metric: ContractMonthMetric, month: string) => ContractTarget | null;
};

/** How many contract months the chart and table lay out: M1–M8, as the engagement runs. */
const CONTRACT_MONTHS = 8;

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
  // The ramp channel carries no target since the contract replaced the M1–M8
  // sheet (30 October 2026): its panels are drawn untargeted.
  const targets: RampTarget[] = [];
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

  /*
   * The contract's months. A frozen month is rebuilt from its frozen channel
   * figures — every channel's spend, approvals, funded deals and volume,
   * Direct & other's included — so a baseline month reads the same until a
   * correction is frozen; the month in progress and any month not frozen are
   * live. A frozen month missing any figure it needs is read live whole,
   * never half and half.
   */
  const approvalKey = 'uw_approved';
  const frozenContractInput = (month: string): ContractMonthInput | null => {
    if (!valueKey) return null;
    const rows = [...frozenAll].filter(([key]) => key.split('|')[1] === month);
    if (rows.length === 0) return null;
    const at = (platform: string, metric: string) => frozenAll.get(`${platform}|${month}|${metric}`)?.value;
    const platforms = [...new Set(rows.map(([key]) => key.split('|')[0]!))].filter((p) => p !== 'unattributed');
    const dealsBySource: Record<string, number> = {};
    const volumeBySource: Record<string, number> = {};
    let adSpend = 0;
    let approvals = 0;
    for (const p of platforms) {
      const deals = at(p, `stage:${valueKey}`);
      const volume = at(p, 'funded_volume');
      const approved = at(p, `stage:${approvalKey}`);
      if (deals == null || approved == null) return null;
      dealsBySource[p] = deals;
      volumeBySource[p] = volume ?? 0;
      approvals += approved;
      if (isPaidChannel(p)) {
        const spend = at(p, 'spend');
        if (spend == null) return null;
        adSpend += spend;
      }
    }
    const unattributedDeals = at('unattributed', `stage:${valueKey}`);
    const unattributedApprovals = at('unattributed', `stage:${approvalKey}`);
    const unattributedVolume = at('unattributed', 'funded_volume');
    if (unattributedDeals == null || unattributedApprovals == null || unattributedVolume == null) return null;
    return {
      adSpend,
      approvals: approvals + unattributedApprovals,
      deals: Object.values(dealsBySource).reduce((n, d) => n + d, 0) + unattributedDeals,
      dealsBySource,
      unattributedDeals,
      volumeBySource,
      unattributedVolume,
      spendRead: true,
      crmRead: true,
    };
  };
  const liveContractInput = (month: string): ContractMonthInput => {
    const bucket = buckets.find((b) => monthKeyOf(b.start) === month);
    const dealsBySource = Object.fromEntries(
      Object.entries(bucket?.stagesByPlatform ?? {}).map(([source, stages]) => [source, valueKey ? (stages[valueKey] ?? 0) : 0]),
    );
    const volumeBySource = bucket?.valueVolumeByPlatform ?? {};
    const attributedVolume = Object.values(volumeBySource).reduce((sum, v) => sum + v, 0);
    return {
      adSpend: Object.entries(bucket?.spendByPlatform ?? {})
        .filter(([p]) => isPaidChannel(p))
        .reduce((sum, [, v]) => sum + v, 0),
      approvals: bucket?.stages[approvalKey] ?? 0,
      deals: valueKey ? (bucket?.stages[valueKey] ?? 0) : 0,
      dealsBySource,
      unattributedDeals: valueKey ? (bucket?.unattributedStages[valueKey] ?? 0) : 0,
      volumeBySource,
      unattributedVolume: (bucket?.valueVolume ?? 0) - attributedVolume,
      spendRead: bucket?.spendIngested ?? false,
      crmRead: bucket?.crmIngested ?? false,
    };
  };
  const contractMonthActual = (metric: ContractMonthMetric, month: string): MonthActual =>
    contractMonthActuals(frozenContractInput(month) ?? liveContractInput(month), { valueStage: valueKey })[metric];
  const contractTargets = contractRampTargets(ramp.contract, ramp.startMonth, CONTRACT_MONTHS);
  const isContractMetric = (m: string): m is ContractMetric => m === 'cpa' || m === 'costPerFundedDeal' || m === 'fundedAmount';

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
    'The contract sets this month by month. Its figures have not been recorded (contract_targets) yet.';
  const deals = `${valueLabel.toLowerCase()} deals`;
  const money = { kind: 'currency', currency } as const;

  /** A contract panel: every source, against the contract where it sets a target. */
  const contractPanel = (
    metric: ContractMonthMetric,
    label: string,
    formulaKey: string,
    format: RampPanel['format'],
    basis: string,
  ): RampPanel => {
    const direction = improvementDirectionFor(formulaKey);
    const targets = isContractMetric(metric) ? contractTargets : contractTargets.map((t) => ({ ...t, [metric]: null }));
    return {
      metric,
      label,
      format,
      direction,
      missing: AWAITING,
      series: rampSeries(targets, metric, { startMonth: ramp.startMonth, actualFor: () => null, direction }),
      channel: 'All sources',
      basis,
      timeline:
        ramp.startMonth === null
          ? null
          : rampTimeline(targets, metric, {
              startMonth: ramp.startMonth,
              baselineMonths,
              currentMonth,
              readActual: (month) => contractMonthActual(metric, month),
              direction,
            }),
    };
  };
  const contractPanels: Record<ContractMonthMetric, RampPanel> = {
    costPerFundedDeal: contractPanel('costPerFundedDeal', `Cost per ${valueLabel.toLowerCase()} deal (all sources)`, 'cost_per_funded_deal', money, `Every ad platform's spend ÷ every source's ${deals}`),
    cpa: contractPanel('cpa', 'Cost per acquisition (all sources)', 'cpa', money, "Every ad platform's spend ÷ every source's approvals"),
    fundedAmount: contractPanel('fundedAmount', `${valueLabel} volume (all sources except lead vendors)`, 'funded_volume', money, `${valueLabel} volume from every source but lead vendors`),
    fundedDeals: contractPanel('fundedDeals', `${valueLabel} deals (all sources except lead vendors)`, 'stage_count', { kind: 'projection' }, `${valueLabel} deals from every source but lead vendors`),
    budget: contractPanel('budget', 'Ad spend (all ad platforms)', 'paid_media_spend', money, "Every ad platform's spend"),
    approvals: contractPanel('approvals', 'Approvals (all sources)', 'stage_count', { kind: 'projection' }, "Every source's approvals"),
  };

  // The ramp channel's own panels carry no target: every target is the contract's.
  const channelPanel = (metric: RampMetricKey, label: string, formulaKey: string, format: RampPanel['format'], basis: string): RampPanel => ({
    ...panelFor(metric, label, formulaKey, format, AWAITING, basis),
  });

  return {
    platform,
    channel,
    startMonth: ramp.startMonth,
    targets,
    primary: channelPanel('costPerFundedDeal', `Cost per ${valueLabel.toLowerCase()} deal`, 'cost_per_funded_deal', money, `${channel} spend ÷ ${deals} attributed to ${channel}`),
    secondary: channelPanel('cpa', 'CPA · cost per approval', 'cpa', money, `${channel} spend ÷ UW approvals attributed to ${channel}`),
    compact: [
      channelPanel('budget', 'Budget', 'paid_media_spend', money, `${channel} spend`),
      channelPanel('approvals', 'Approvals', 'stage_count', { kind: 'projection' }, `UW approvals attributed to ${channel}`),
      channelPanel('fundedDeals', `${valueLabel} deals`, 'stage_count', { kind: 'projection' }, `${valueLabel} deals attributed to ${channel}`),
      channelPanel('fundedAmount', `${valueLabel} volume`, 'funded_volume', money, `${valueLabel} volume attributed to ${channel}`),
    ],
    monthActual,
    contract: {
      source: ramp.contract?.source ?? null,
      primary: contractPanels.costPerFundedDeal,
      panels: contractPanels,
      monthActual: contractMonthActual,
      target: (metric, month) => (isContractMetric(metric) ? contractTarget(ramp.contract, metric, month) : null),
    },
  };
}

/**
 * One card of a scorecard: this month's figure for one metric, its target and
 * the verdict.
 *
 * Every target is the contract's (30 October 2026). The verdict is
 * `scorecardVerdict` in core, so "on target" means one thing: a month in
 * progress is judged against pace for a count or a spend, and as it stands for
 * a cost. A month the contract states as a range is on target at its low end.
 * Before the contract starts there is no target this month, and the card names
 * the first one instead of inventing one.
 */
export type ScorecardRow = {
  metric: RampMetricKey;
  label: string;
  format: RampPanel['format'];
  actual: MonthActual;
  /** The target, the low end of a range. */
  target: number | null;
  /** The high end, where the contract states a range. */
  targetHigh: number | null;
  verdict: ScorecardVerdict | null;
  /** Before the contract starts: the first target and the month it applies to. */
  upcoming: { month: string; value: number } | null;
  /** A figure shown without a target or verdict. */
  untargeted?: boolean;
  /** A cost's basis line, for `CostPerDealFigure`: the noun and the ⓘ sentence. */
  cost?: { noun: readonly [string, string]; explanation: (spend: string, n: string) => string };
};

type ScorecardInput = { currentMonth: string; elapsed: number; metrics: Metrics; valueLabel: string };

/** The ramp channel's card (Google Ads): its own figures this month, no targets. */
export function scorecardRows(panels: RampPanels, input: ScorecardInput): ScorecardRow[] {
  const { currentMonth, valueLabel } = input;
  const rows: [RampMetricKey, string][] = [
    ['costPerFundedDeal', `Cost per ${valueLabel.toLowerCase()} deal`],
    ['cpa', 'CPA'],
    ['fundedDeals', `${valueLabel} deals`],
    ['fundedAmount', `${valueLabel} volume`],
    ['budget', 'Spend'],
  ];
  const panelOf = (metric: RampMetricKey) =>
    [panels.primary, panels.secondary, ...panels.compact].find((p) => p.metric === metric)!;
  return rows.map(([metric, label]) => ({
    metric,
    label,
    format: panelOf(metric).format,
    actual: panels.monthActual(metric, currentMonth),
    target: null,
    targetHigh: null,
    verdict: null,
    upcoming: null,
    untargeted: true,
  }));
}

const CONTRACT_ROWS: { metric: ContractMonthMetric; formulaKey: string; kind: 'rate' | 'count' }[] = [
  { metric: 'costPerFundedDeal', formulaKey: 'cost_per_funded_deal', kind: 'rate' },
  { metric: 'cpa', formulaKey: 'cpa', kind: 'rate' },
  { metric: 'fundedAmount', formulaKey: 'funded_volume', kind: 'count' },
  { metric: 'fundedDeals', formulaKey: 'stage_count', kind: 'count' },
];

/**
 * This month against the contract, on Executive's All sources card: cost per
 * funded deal and cost per acquisition across every source, funded volume
 * across every source but lead vendors, and funded deals beside them with no
 * target — the contract sets volume only.
 */
export function contractRows(panels: RampPanels, input: ScorecardInput): ScorecardRow[] {
  const { currentMonth, elapsed, valueLabel } = input;
  const c = panels.contract;
  const start = panels.startMonth;
  const beforeStart = start !== null && currentMonth < start;
  const noTarget =
    c.source === null
      ? 'No contract targets are recorded.'
      : beforeStart
        ? `Targets begin ${monthLabelOf(start!)}.`
        : 'The contract sets no target for this month.';
  const deal = valueLabel.toLowerCase();
  const costs: Partial<Record<ContractMonthMetric, ScorecardRow['cost']>> = {
    costPerFundedDeal: {
      noun: ['deal', 'deals'],
      explanation: (spend, n) => `${spend} of ad spend divided by all ${n} ${deal} deals, from every source.`,
    },
    cpa: {
      noun: ['approval', 'approvals'],
      explanation: (spend, n) => `${spend} of ad spend divided by all ${n} approvals, from every source.`,
    },
  };
  return CONTRACT_ROWS.map(({ metric, formulaKey, kind }) => {
    const panel = c.panels[metric];
    const actual = c.monthActual(metric, currentMonth);
    const target = c.target(metric, currentMonth);
    const untargeted = metric === 'fundedDeals';
    const first = start ? c.target(metric, start) : null;
    return {
      metric,
      label: panel.label,
      format: panel.format,
      actual,
      target: target?.low ?? null,
      targetHigh: target?.high ?? null,
      upcoming: !untargeted && beforeStart && first ? { month: start!, value: first.low } : null,
      untargeted,
      cost: costs[metric],
      verdict: untargeted
        ? null
        : scorecardVerdict({
            actual: actual.value,
            actualReason: actual.reason,
            target: target?.low ?? null,
            noTarget,
            direction: improvementDirectionFor(formulaKey),
            kind,
            partial: true,
            elapsed,
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

/**
 * The contract as one month-by-month table on Monthly performance: the
 * baseline months first with actuals only, then M1–M8 with each targeted
 * figure against the contract. Every figure is across sources, as the
 * contract measures them (30 October 2026).
 *
 * Every cell's verdict is `scorecardVerdict`, the scorecard's rule, so a month
 * cannot read "on target" on one screen and "behind" on the other: a finished
 * month against its target, the month in progress against pace. A month that
 * has not happened shows its target and nothing else.
 */
export type RampTableColumn = {
  key: ContractMonthMetric;
  metric: ContractMonthMetric;
  label: (valueLabel: string) => string;
  formulaKey: string;
  kind: 'rate' | 'count';
  /** False where the contract sets no target for the figure. */
  targeted: boolean;
};

export const RAMP_TABLE_COLUMNS: RampTableColumn[] = [
  { key: 'budget', metric: 'budget', label: () => 'Ad spend', formulaKey: 'paid_media_spend', kind: 'count', targeted: false },
  { key: 'approvals', metric: 'approvals', label: () => 'Approvals', formulaKey: 'stage_count', kind: 'count', targeted: false },
  { key: 'cpa', metric: 'cpa', label: () => 'Cost per acquisition', formulaKey: 'cpa', kind: 'rate', targeted: true },
  { key: 'fundedDeals', metric: 'fundedDeals', label: (v) => `${v} deals`, formulaKey: 'stage_count', kind: 'count', targeted: false },
  { key: 'costPerFundedDeal', metric: 'costPerFundedDeal', label: (v) => `Cost per ${v.toLowerCase()} deal`, formulaKey: 'cost_per_funded_deal', kind: 'rate', targeted: true },
  { key: 'fundedAmount', metric: 'fundedAmount', label: (v) => `${v} volume`, formulaKey: 'funded_volume', kind: 'count', targeted: true },
];

export type RampTableCell = {
  actual: MonthActual | null;
  target: number | null;
  targetHigh: number | null;
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

export function rampTableRows(panels: RampPanels, input: { currentMonth: string; elapsed: number }): RampTableRow[] {
  const c = panels.contract;
  const timeline = c.primary.timeline;
  if (!timeline) return [];
  return timeline.points.map((point) => {
    const future = point.month > input.currentMonth;
    const inProgress = point.month === input.currentMonth;
    const cells = Object.fromEntries(
      RAMP_TABLE_COLUMNS.map(({ key, metric, formulaKey, kind, targeted }) => {
        const target = targeted && point.monthIndex !== null ? c.target(metric, point.month) : null;
        const actual = future ? null : c.monthActual(metric, point.month);
        const verdict =
          point.monthIndex === null || future || !target
            ? null
            : scorecardVerdict({
                actual: actual?.value ?? null,
                actualReason: actual?.reason ?? null,
                target: target.low,
                noTarget: null,
                direction: improvementDirectionFor(formulaKey),
                kind,
                partial: inProgress,
                elapsed: inProgress ? input.elapsed : 1,
              });
        return [key, { actual, target: target?.low ?? null, targetHigh: target?.high ?? null, verdict }];
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
