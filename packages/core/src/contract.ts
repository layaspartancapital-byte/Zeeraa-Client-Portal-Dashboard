import { allSourcesCostPer } from './attribution';
import { isVendorChannel } from './lead-channel';
import { isMonthKey, rampMonthKey, type MonthActual, type MonthKey, type RampTarget } from './ramp';

/**
 * The signed contract's targets (30 October 2026, client decision): what the
 * engagement is judged on, replacing the M1–M8 planning sheet
 * (`engagement_targets`) as the source of every target on screen.
 *
 * Configuration, in the `contract_targets` row, because the figures are one
 * client's contract. Each metric is a schedule of calendar months: a figure
 * applies from its `from` month until the next entry's (or its own `to`), so
 * "$2M from April onward" is one entry. A month may carry a range — October's
 * funded volume is $100K–$150K — and is on target at its low end.
 *
 * Every target is program-wide. Cost per acquisition and cost per funded deal
 * are every ad platform's spend over every source's approvals and funded
 * deals; funded volume is every source's except lead vendors'. The contract
 * sets no target for the count of funded deals.
 */
export type ContractEntry = { from: MonthKey; to?: MonthKey; value?: number; low?: number; high?: number };

export type ContractTargets = {
  /** Where the figures come from, named wherever they render: "Zeeraa proposal, page 22". */
  source: string;
  cpa: ContractEntry[];
  costPerFundedDeal: ContractEntry[];
  fundedAmount: ContractEntry[];
};

export type ContractMetric = 'cpa' | 'costPerFundedDeal' | 'fundedAmount';
export const CONTRACT_METRICS: readonly ContractMetric[] = ['cpa', 'costPerFundedDeal', 'fundedAmount'];

/** A month's target: `low` decides the verdict; `high` is shown where the contract states a range. */
export type ContractTarget = { low: number; high: number | null };

function parseEntries(value: unknown): ContractEntry[] | null {
  if (!Array.isArray(value)) return null;
  const out: ContractEntry[] = [];
  for (const e of value) {
    if (!e || typeof e !== 'object') return null;
    const { from, to, value: v, low, high } = e as Record<string, unknown>;
    if (typeof from !== 'string' || !isMonthKey(from)) return null;
    if (to !== undefined && (typeof to !== 'string' || !isMonthKey(to))) return null;
    const num = (x: unknown) => (x === undefined ? undefined : typeof x === 'number' && Number.isFinite(x) ? x : NaN);
    const entry = { from, to: to as string | undefined, value: num(v), low: num(low), high: num(high) };
    if ([entry.value, entry.low, entry.high].some((x) => Number.isNaN(x))) return null;
    if (entry.value === undefined && entry.low === undefined) return null;
    out.push(Object.fromEntries(Object.entries(entry).filter(([, x]) => x !== undefined)) as ContractEntry);
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

/** The config row, validated; null where it is absent or malformed, so nothing renders a guessed target. */
export function parseContractTargets(value: unknown): ContractTargets | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.source !== 'string' || v.source.trim() === '') return null;
  const cpa = parseEntries(v.cpa ?? []);
  const costPerFundedDeal = parseEntries(v.costPerFundedDeal ?? []);
  const fundedAmount = parseEntries(v.fundedAmount ?? []);
  if (!cpa || !costPerFundedDeal || !fundedAmount) return null;
  return { source: v.source, cpa, costPerFundedDeal, fundedAmount };
}

/** The target for one month, or null where the contract states none. */
export function contractTarget(contract: ContractTargets | null, metric: ContractMetric, month: MonthKey): ContractTarget | null {
  if (!contract) return null;
  const entries = contract[metric];
  let found: ContractEntry | null = null;
  for (const e of entries) {
    if (e.from > month) break;
    if (e.to !== undefined && e.to < month) continue;
    found = e;
  }
  if (!found) return null;
  const low = found.low ?? found.value!;
  return { low, high: found.high ?? null };
}

/**
 * The contract as ramp targets, M1 to Mn, for the timeline and table code
 * that reads targets by ramp month. Each figure is the month's low end; the
 * range itself is `contractTarget`'s to show.
 */
export function contractRampTargets(contract: ContractTargets | null, startMonth: MonthKey | null, months: number): RampTarget[] {
  if (!contract || !startMonth) return [];
  return Array.from({ length: months }, (_, i) => {
    const month = rampMonthKey(startMonth, i + 1)!;
    const at = (m: ContractMetric) => contractTarget(contract, m, month)?.low ?? null;
    return {
      monthIndex: i + 1,
      costPerFundedDeal: at('costPerFundedDeal'),
      cpa: at('cpa'),
      fundedAmount: at('fundedAmount'),
      budget: null,
      approvals: null,
      fundedDeals: null,
    };
  });
}

/**
 * One month across every source, as the contract measures it.
 *
 * Cost per acquisition and cost per funded deal: every ad platform's spend
 * over every source's approvals and funded deals, vendors included (the
 * "All sources" figures, `allSourcesCostPer`). Funded volume and funded deals:
 * every source's except lead vendors'. Spend and approvals are shown beside
 * them untargeted. A month whose spend or CRM was not read has no figure.
 */
export type ContractMonthInput = {
  /** Every ad platform's spend that month. */
  adSpend: number;
  /** Every source's approvals and value-stage deals, vendors included. */
  approvals: number;
  deals: number;
  /** Value-stage deals and volume per source, for the vendor exclusion. */
  dealsBySource: Record<string, number>;
  unattributedDeals: number;
  volumeBySource: Record<string, number>;
  unattributedVolume: number;
  /** Every spend platform read for every day of the month so far. */
  spendRead: boolean;
  crmRead: boolean;
};

export type ContractMonthMetric = ContractMetric | 'fundedDeals' | 'budget' | 'approvals';

export function contractMonthActuals(
  input: ContractMonthInput,
  options: { valueStage: string | null },
): Record<ContractMonthMetric, MonthActual> {
  const spendProblem = input.spendRead ? null : 'Ad spend was not read for every day of this month.';
  const crmProblem = input.crmRead ? null : 'Salesforce is not synced for this month.';
  const noValue = options.valueStage ? null : 'No funnel stage is configured to count value.';
  const cost = (denominator: number, empty: string): MonthActual => {
    const problem = spendProblem ?? crmProblem ?? noValue;
    if (problem) return { value: null, reason: problem };
    if (denominator === 0) return { value: null, reason: empty, empty: true };
    const c = allSourcesCostPer({ adSpend: input.adSpend, deals: denominator });
    return { value: c.value, reason: null, cost: c };
  };
  const exVendors = (bySource: Record<string, number>, unattributed: number) =>
    Object.entries(bySource)
      .filter(([source]) => !isVendorChannel(source))
      .reduce((sum, [, n]) => sum + n, unattributed);
  const crm = (value: number): MonthActual => {
    const problem = crmProblem ?? noValue;
    return problem ? { value: null, reason: problem } : { value, reason: null };
  };
  return {
    cpa: cost(input.approvals, 'No approvals yet.'),
    costPerFundedDeal: cost(input.deals, 'No deals yet.'),
    fundedAmount: crm(exVendors(input.volumeBySource, input.unattributedVolume)),
    fundedDeals: crm(exVendors(input.dealsBySource, input.unattributedDeals)),
    budget: spendProblem ? { value: null, reason: spendProblem } : { value: input.adSpend, reason: null },
    approvals: crmProblem ? { value: null, reason: crmProblem } : { value: input.approvals, reason: null },
  };
}

export const CONTRACT_SCOPE = {
  cost: 'all sources',
  volume: 'all sources except lead vendors',
} as const;
