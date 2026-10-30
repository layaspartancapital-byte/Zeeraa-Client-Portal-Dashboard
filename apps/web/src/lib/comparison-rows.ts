import {
  cohortConversionRate,
  delta,
  improvementDirectionFor,
  isPaidChannel,
  isVendorChannel,
  platformLabel,
  rangeLengthDays,
  type ContractTarget,
  type DateRange,
  type Delta,
  type PopulationVerdict,
  type StageCohorts,
} from '@zeeraa/core';
import type { MonthlyPerformance } from '@/lib/reporting';
import { approvalStageKey } from '@/lib/all-sources';

/**
 * The Comparison page's rows (30 October 2026): every KPI for one period,
 * then two periods side by side with the change between them.
 *
 * Pure — the inputs are read by `lib/comparison.ts` — so the page, the Excel
 * export and the number check build the same rows from the same reads. A
 * figure a source does not have (ad spend for SEO/Organic, calls for one
 * channel) is null with its reason and renders as "—", never 0; a count in a
 * read period is a measurement even at zero. Whether a change is good comes
 * from the metric's formula (`improvementDirectionFor`), never from here.
 */

/**
 * `points` is a figure already in percentage points (Semrush visibility).
 * `cents` is a small cost shown to the cent (CPC, cost per lead, cost per
 * MQL); every other amount is `money`, in whole dollars.
 */
export type ComparisonFormat = 'money' | 'cents' | 'count' | 'percent' | 'points' | 'seconds' | 'number';

export type ComparisonCell = {
  value: number | null;
  /** Why there is no figure, for the "—" tip. */
  reason: string | null;
  /** What a cost was divided by: "based on N deals". */
  basis: { n: number; noun: string } | null;
  /** The contract's target for this period, where it sets one. */
  target: ContractTarget | null;
  /**
   * The source was not read for the period: a `Not measured` badge, never a
   * dash. A figure the source simply does not have (no ad spend) or an empty
   * denominator ("No deals yet") is a dash with its reason.
   */
  unmeasured?: boolean;
};

export type ComparisonRowSpec = {
  section: 'Ads' | 'Funnel' | 'Cost' | 'Calls' | 'SEO';
  key: string;
  label: string;
  format: ComparisonFormat;
  /** The formula the direction of a change is read from. */
  formulaKey: string;
};

export type PeriodRows = Map<string, ComparisonRowSpec & { cell: ComparisonCell }>;

export type ComparisonRow = ComparisonRowSpec & {
  a: ComparisonCell;
  b: ComparisonCell;
  /** A minus B, where both have a figure. */
  change: number | null;
  /** The change over B; null where B is zero or either is missing. */
  pct: number | null;
  /** Whether the change is an improvement for this metric; `level` where it declares no direction. */
  assessment: Delta['assessment'] | null;
};

/** What one period needs read, for one source. */
export type PeriodInput = {
  range: DateRange;
  mp: MonthlyPerformance;
  /** `all`, a channel key, or `unattributed` (Direct & other). */
  source: string;
  /** Not-measured reasons where a source was not read for the period. */
  crmUnmeasured: string | null;
  spendUnmeasured: string | null;
  callsUnmeasured: string | null;
  /**
   * The frozen channel figures where the period is one frozen calendar month:
   * `platform|metric` → value (`spend`, `stage:<key>`, `funded_volume`).
   */
  frozen: Map<string, number> | null;
  calls: {
    handled: number;
    connectRate: number | null;
    medianSeconds: number | null;
    withinFiveShare: number | null;
    /** Leads the speed figures are over, for their gate. */
    called: number;
  } | null;
  seo: { organicKeywords: number | null; top10: number | null; visibility: number | null } | null;
  /** The contract's targets for the period, where it is one calendar month with them. */
  contract: { cpa: ContractTarget | null; costPerFundedDeal: ContractTarget | null; fundedAmount: ContractTarget | null } | null;
  /** The tenant's population gate, `metrics.population`. */
  population: (key: string, denominator: number) => PopulationVerdict;
};

const cell = (value: number | null, reason: string | null = null, extra: Partial<ComparisonCell> = {}): ComparisonCell => ({
  value,
  reason: value === null ? (reason ?? 'No figure for this period.') : null,
  basis: null,
  target: null,
  ...extra,
});

/** Every row for one period and source. */
export function periodRows(input: PeriodInput): PeriodRows {
  const { mp, source } = input;
  const rows: PeriodRows = new Map();
  const add = (spec: ComparisonRowSpec, c: ComparisonCell) => rows.set(spec.key, { ...spec, cell: c });

  const value = mp.valueStageKey;
  const approval = approvalStageKey(mp.stages);
  const all = source === 'all';
  const channel = all ? null : source === 'unattributed' ? null : (mp.channels.find((c) => c.platform === source) ?? null);
  const paid = all || (source !== 'unattributed' && isPaidChannel(source));
  const noSpend = all ? null : paid ? null : `${source === 'unattributed' ? 'Direct & other' : platformLabel(source)} has no ad spend.`;

  /* Counts, frozen where the period is a frozen month. */
  // A channel's live figure, for a source the freeze did not hold.
  const liveOf = (platform: string, metric: string): number => {
    const row = platform === 'unattributed' ? mp.unattributed : mp.channels.find((c) => c.platform === platform);
    if (!row) return 0;
    if (metric === 'spend') return 'spend' in row ? row.spend : 0;
    if (metric === 'funded_volume') return row.valueVolume;
    return (row.stages as Record<string, number>)[metric.slice('stage:'.length)] ?? 0;
  };
  const frozenFor = (metric: string): number | null => {
    if (!input.frozen) return null;
    if (all) {
      // Every source, each from the freeze where it was frozen and live where
      // it was not — summing the frozen ones alone dropped a source the
      // freeze never held (30 October 2026).
      const platforms = [...mp.channels.map((c) => c.platform), 'unattributed'].filter(
        (p) => metric !== 'spend' || isPaidChannel(p),
      );
      return platforms.reduce((sum, p) => sum + (input.frozen!.get(`${p}|${metric}`) ?? liveOf(p, metric)), 0);
    }
    // A source the freeze did not hold reads live, never as an invented zero.
    return input.frozen.get(`${source}|${metric}`) ?? null;
  };

  const stages = all ? mp.total.stages : source === 'unattributed' ? mp.unattributed.stages : (channel?.stages ?? {});
  const cohorts: StageCohorts = all ? mp.total.cohorts : source === 'unattributed' ? mp.unattributed.cohorts : (channel?.cohorts ?? {});
  const stageCount = (key: string | null): number | null => {
    if (!key) return null;
    if (input.crmUnmeasured) return null;
    if (mp.stageStatus[key]?.blocked) return null;
    return frozenFor(`stage:${key}`) ?? stages[key] ?? 0;
  };
  const crmReason = input.crmUnmeasured ?? 'This stage is not measured.';

  const spend = noSpend || input.spendUnmeasured ? null : (frozenFor('spend') ?? (all ? mp.total.spend : (channel?.spend ?? 0)));
  const spendReason = noSpend ?? input.spendUnmeasured;
  const impressions = noSpend || input.spendUnmeasured ? null : all ? mp.total.impressions : (channel?.impressions ?? 0);
  const clicks = noSpend || input.spendUnmeasured ? null : all ? mp.total.clicks : (channel?.clicks ?? 0);

  /* Ads */
  add({ section: 'Ads', key: 'spend', label: 'Ad spend', format: 'money', formulaKey: 'paid_media_spend' }, cell(spend, spendReason));
  add({ section: 'Ads', key: 'impressions', label: 'Impressions', format: 'count', formulaKey: 'impressions' }, cell(impressions, spendReason));
  add({ section: 'Ads', key: 'clicks', label: 'Clicks', format: 'count', formulaKey: 'clicks' }, cell(clicks, spendReason));
  add(
    { section: 'Ads', key: 'ctr', label: 'CTR', format: 'percent', formulaKey: 'ctr' },
    cell(impressions && clicks !== null ? clicks / impressions : null, spendReason ?? 'No impressions.'),
  );
  add(
    { section: 'Ads', key: 'cpc', label: 'CPC', format: 'cents', formulaKey: 'cpc' },
    cell(spend !== null && clicks ? spend / clicks : null, spendReason ?? 'No clicks.', clicks ? { basis: { n: clicks, noun: 'clicks' } } : {}),
  );

  /* Funnel */
  const byKey = new Map(mp.stages.map((s) => [s.key, s]));
  const leadKey = mp.stages.find((s) => s.source === 'leads')?.key ?? null;
  const mqlKey = mp.stages.find((s) => s.source === 'qualified_leads')?.key ?? null;
  const appKey = byKey.has('application') ? 'application' : null;
  const sqlKey = byKey.has('sql') ? 'sql' : null;
  const leads = stageCount(leadKey);
  const mql = stageCount(mqlKey);
  const approvals = stageCount(approval);
  const deals = stageCount(value);
  const volume = input.crmUnmeasured || !value ? null : (frozenFor('funded_volume') ?? (all ? mp.total.valueVolume : source === 'unattributed' ? mp.unattributed.valueVolume : (channel?.valueVolume ?? 0)));
  const offered = all ? mp.total.offered : source === 'unattributed' ? mp.unattributed.offered : (channel?.offered ?? { amount: 0, deals: 0 });
  const label = (key: string | null, fallback: string) => (key ? (byKey.get(key)?.label ?? fallback) : fallback);
  const valueLabel = label(value, 'Funded');

  const rate = (from: string | null, to: string | null): ComparisonCell => {
    if (!from || !to) return cell(null, 'This stage is not configured.');
    if (input.crmUnmeasured) return cell(null, input.crmUnmeasured);
    if (mp.stageStatus[from]?.blocked || mp.stageStatus[to]?.blocked) return cell(null, 'One of these stages is not measured.');
    const r = cohortConversionRate(cohorts, from, to);
    if (r.rate === null) return cell(null, `No ${label(from, from).toLowerCase()} in this period.`);
    const gate = input.population('stage_conversion_rate', r.denominator);
    return gate.sufficient ? cell(r.rate, null, { basis: { n: r.denominator, noun: `at ${label(from, from)}` } }) : cell(null, gate.reason);
  };

  add({ section: 'Funnel', key: 'leads', label: 'Leads', format: 'count', formulaKey: 'leads_created' }, cell(leads, crmReason));
  add({ section: 'Funnel', key: 'mql', label: label(mqlKey, 'MQL'), format: 'count', formulaKey: 'stage_count' }, cell(mql, crmReason));
  add({ section: 'Funnel', key: 'mql_rate', label: `${label(mqlKey, 'MQL')} rate`, format: 'percent', formulaKey: 'qualified_rate' }, rate(leadKey, mqlKey));
  add({ section: 'Funnel', key: 'applications', label: 'Applications', format: 'count', formulaKey: 'stage_count' }, cell(stageCount(appKey), crmReason));
  add({ section: 'Funnel', key: 'sql', label: label(sqlKey, 'SQL'), format: 'count', formulaKey: 'stage_count' }, cell(stageCount(sqlKey), crmReason));
  add({ section: 'Funnel', key: 'approvals', label: 'Approvals / offers', format: 'count', formulaKey: 'stage_count' }, cell(approvals, crmReason));
  add(
    { section: 'Funnel', key: 'offer_amount', label: 'Offer amount', format: 'money', formulaKey: 'funded_volume' },
    cell(input.crmUnmeasured ? null : offered.amount, crmReason, offered.deals ? { basis: { n: offered.deals, noun: 'priced offers' } } : {}),
  );
  add({ section: 'Funnel', key: 'funded_deals', label: `${valueLabel} deals`, format: 'count', formulaKey: 'stage_count' }, cell(deals, crmReason));
  add(
    { section: 'Funnel', key: 'funded_volume', label: `${valueLabel} volume`, format: 'money', formulaKey: 'funded_volume' },
    cell(volume, crmReason),
  );
  if (all && value) {
    // The contract's measure: every source's volume but lead vendors'. Its own
    // row, because the row above counts vendors' deals and the target does not.
    const vendorOut =
      input.crmUnmeasured
        ? null
        : mp.channels.filter((c) => !isVendorChannel(c.platform)).reduce((n, c) => n + c.valueVolume, 0) + mp.unattributed.valueVolume;
    // Each source from the freeze where it was frozen and live where it was
    // not, as `frozenFor` reads every source: the ramp channel's volume is
    // frozen under the ramp's name, and summing frozen channel figures alone
    // dropped it — September read $97,600 for $153,500 (30 October 2026).
    const frozenVendorOut = input.frozen
      ? [...mp.channels.map((c) => c.platform), 'unattributed']
          .filter((p) => !isVendorChannel(p))
          .reduce((sum, p) => sum + (input.frozen!.get(`${p}|funded_volume`) ?? liveOf(p, 'funded_volume')), 0)
      : null;
    add(
      { section: 'Funnel', key: 'funded_volume_contract', label: `${valueLabel} volume, lead vendors excluded`, format: 'money', formulaKey: 'funded_volume' },
      cell(frozenVendorOut ?? vendorOut, crmReason, { target: input.contract?.fundedAmount ?? null }),
    );
  }
  add(
    { section: 'Funnel', key: 'avg_deal', label: 'Average deal size', format: 'money', formulaKey: 'funded_volume' },
    cell(volume !== null && deals ? volume / deals : null, deals === 0 ? `No ${valueLabel.toLowerCase()} deals.` : crmReason, deals ? { basis: { n: deals, noun: 'deals' } } : {}),
  );
  const eventStages = mp.stages.filter((s) => !mp.stageStatus[s.key]?.blocked);
  for (let i = 0; i + 1 < eventStages.length; i += 1) {
    const from = eventStages[i]!;
    const to = eventStages[i + 1]!;
    if (from.key === leadKey && to.key === mqlKey) continue; // the MQL rate, above
    add(
      { section: 'Funnel', key: `conv:${from.key}:${to.key}`, label: `${from.label} → ${to.label}`, format: 'percent', formulaKey: 'stage_conversion_rate' },
      rate(from.key, to.key),
    );
  }

  // A pair the funnel draws side by side with a stage between them that it
  // does not (UW approved → Funded, past Offer): its own conversion, measured
  // as every other.
  for (const step of funnelSteps(mp)) {
    if (!step.conversion || rows.has(step.conversion)) continue;
    const [, from, to] = step.conversion.split(':');
    add(
      { section: 'Funnel', key: step.conversion, label: `${label(from!, from!)} → ${label(to!, to!)}`, format: 'percent', formulaKey: 'stage_conversion_rate' },
      rate(from!, to!),
    );
  }

  /* Cost: spend over this source's own counts; every source's for All. */
  const cost = (n: number | null, noun: string, target: ContractTarget | null = null): ComparisonCell => {
    if (spend === null) return cell(null, spendReason);
    if (n === null) return cell(null, crmReason);
    if (n === 0) return cell(null, `No ${noun} yet.`, { target });
    return cell(spend / n, null, { basis: { n, noun }, target });
  };
  add({ section: 'Cost', key: 'cpl', label: 'Cost per lead', format: 'cents', formulaKey: 'cost_per_stage' }, cost(leads, 'leads'));
  add({ section: 'Cost', key: 'cpmql', label: `Cost per ${label(mqlKey, 'MQL')}`, format: 'cents', formulaKey: 'cost_per_stage' }, cost(mql, label(mqlKey, 'MQL') + 's'));
  add(
    { section: 'Cost', key: 'cpa', label: 'Cost per acquisition', format: 'money', formulaKey: 'cpa' },
    cost(approvals, 'approvals', all ? (input.contract?.cpa ?? null) : null),
  );
  add(
    { section: 'Cost', key: 'cpfd', label: `Cost per ${valueLabel.toLowerCase()} deal`, format: 'money', formulaKey: 'cost_per_funded_deal' },
    cost(deals, 'deals', all ? (input.contract?.costPerFundedDeal ?? null) : null),
  );

  /* Calls: not split by source. */
  const callsReason = !all ? 'Calls are not split by source.' : (input.callsUnmeasured ?? (input.calls ? null : 'Call tracking is not connected.'));
  const calls = !all || input.callsUnmeasured ? null : input.calls;
  const speedGate = calls ? input.population('speed_to_lead', calls.called) : null;
  const speedReason = callsReason ?? (speedGate && !speedGate.sufficient ? speedGate.reason : 'No leads were called.');
  add({ section: 'Calls', key: 'calls', label: 'Calls', format: 'count', formulaKey: 'calls_connected' }, cell(calls?.handled ?? null, callsReason));
  add({ section: 'Calls', key: 'connect_rate', label: 'Connected rate', format: 'percent', formulaKey: 'connect_rate' }, cell(calls?.connectRate ?? null, callsReason ?? 'No calls handled.'));
  add(
    { section: 'Calls', key: 'speed', label: 'Median speed to lead', format: 'seconds', formulaKey: 'speed_to_lead' },
    cell(speedGate?.sufficient ? (calls?.medianSeconds ?? null) : null, speedReason),
  );
  add(
    { section: 'Calls', key: 'within5', label: 'Called within 5 minutes', format: 'percent', formulaKey: 'connect_rate' },
    cell(speedGate?.sufficient ? (calls?.withinFiveShare ?? null) : null, speedReason),
  );

  /* SEO: for All and SEO/Organic. */
  if (all || source === 'organic_search') {
    const seoReason = input.seo ? 'Semrush has no reading for this period.' : 'Semrush is not connected.';
    add({ section: 'SEO', key: 'organic_keywords', label: 'Organic keywords', format: 'count', formulaKey: 'organic_keywords' }, cell(input.seo?.organicKeywords ?? null, seoReason));
    add({ section: 'SEO', key: 'top10', label: 'Top-10 keywords', format: 'count', formulaKey: 'organic_keywords' }, cell(input.seo?.top10 ?? null, seoReason));
    add({ section: 'SEO', key: 'visibility', label: 'Visibility', format: 'points', formulaKey: 'tracked_visibility' }, cell(input.seo?.visibility ?? null, seoReason));
  }
  const unread = new Set([input.crmUnmeasured, input.spendUnmeasured, input.callsUnmeasured].filter((r): r is string => r !== null));
  for (const row of rows.values()) if (row.cell.value === null && row.cell.reason && unread.has(row.cell.reason)) row.cell.unmeasured = true;
  return rows;
}

/** Whether a source has ad spend at all: every source together, or a paid channel. */
export function hasAdSpend(source: string): boolean {
  return source === 'all' || (source !== 'unattributed' && isPaidChannel(source));
}

export type FunnelStep = {
  key: string;
  label: string;
  /** The row holding the stage's count. */
  row: string;
  /** The row holding the conversion from the step before; null on the first. */
  conversion: string | null;
};

/**
 * The funnel as the Comparison page draws it — Lead → MQL → Application → SQL
 * → UW approved → Funded, whichever of those the tenant measures — each step
 * naming the table rows it reads, so the chart is the table's figures.
 */
export function funnelSteps(mp: Pick<MonthlyPerformance, 'stages' | 'stageStatus' | 'valueStageKey'>): FunnelStep[] {
  const approval = approvalStageKey(mp.stages);
  const rowFor = (s: MonthlyPerformance['stages'][number]): string | null =>
    s.source === 'leads'
      ? 'leads'
      : s.source === 'qualified_leads'
        ? 'mql'
        : s.key === 'application'
          ? 'applications'
          : s.key === 'sql'
            ? 'sql'
            : s.key === approval
              ? 'approvals'
              : s.key === mp.valueStageKey
                ? 'funded_deals'
                : null;
  const steps: FunnelStep[] = [];
  let prev: MonthlyPerformance['stages'][number] | null = null;
  for (const s of mp.stages) {
    if (mp.stageStatus[s.key]?.blocked) continue;
    const row = rowFor(s);
    if (!row) continue;
    const conversion = !prev
      ? null
      : prev.source === 'leads' && s.source === 'qualified_leads'
        ? 'mql_rate'
        : `conv:${prev.key}:${s.key}`;
    steps.push({ key: s.key, label: s.label, row, conversion });
    prev = s;
  }
  return steps;
}

/** Two periods side by side: A against B. */
export function compareRows(a: PeriodRows, b: PeriodRows): ComparisonRow[] {
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  return keys.map((key) => {
    const ra = a.get(key);
    const rb = b.get(key);
    const spec = (ra ?? rb)!;
    const ca = ra?.cell ?? cell(null, 'No figure for this period.');
    const cb = rb?.cell ?? cell(null, 'No figure for this period.');
    return {
      section: spec.section,
      key,
      label: spec.label,
      format: spec.format,
      formulaKey: spec.formulaKey,
      a: ca,
      b: cb,
      ...changeBetween(spec.formulaKey, ca.value, cb.value),
    };
  });
}

/**
 * A minus B, its proportion of B, and whether that is an improvement — read
 * from the metric's formula (`improvementDirectionFor`), `level` where it
 * declares no direction. Nulls where either period has no figure.
 */
export function changeBetween(
  formulaKey: string,
  a: number | null,
  b: number | null,
): Pick<ComparisonRow, 'change' | 'pct' | 'assessment'> {
  if (a === null || b === null) return { change: null, pct: null, assessment: null };
  const direction = improvementDirectionFor(formulaKey);
  const d = delta(a, b, direction ?? 'up');
  return { change: d.absolute, pct: d.relative, assessment: direction === null ? 'level' : d.assessment };
}

/** Said above the table when the periods are not the same length; null when they are. */
export function lengthNote(a: DateRange, b: DateRange): string | null {
  const da = rangeLengthDays(a);
  const db = rangeLengthDays(b);
  if (da === db) return null;
  return `Period A is ${da} days and Period B is ${db}: counts and totals cover different lengths of time, so compare rates and costs first.`;
}
