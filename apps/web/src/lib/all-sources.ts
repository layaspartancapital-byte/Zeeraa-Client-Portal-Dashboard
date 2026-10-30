import { allSourcesCostPer, isPaidChannel, stageBeforeValue, type ChannelCostPerDeal, type StageDefinition } from '@zeeraa/core';
import type { MonthlyPerformance } from '@/lib/reporting';

/**
 * Executive's "All sources" card: the period's deals from every source, every
 * ad platform's spend, and the two all-sources costs between them (30 October
 * 2026; `docs/brief-amendments.md`, "the All sources card").
 *
 * Read from the same `monthlyPerformance` result as All funded and the
 * Efficiency table, so the card cannot disagree with either: its deals are All
 * funded's total, its spend is the sum of the Efficiency rows. The number
 * checks hold it to both.
 */
export type AllSources = {
  /** Every deal reaching the value stage, attributed or not. */
  deals: number;
  /** Every deal reaching the stage before value (approval), attributed or not. */
  approvals: number;
  /** Ad platforms only: no vendor or organic cost is ingested. */
  adSpend: number;
  /** The ad platforms that spent in the period, in table order. */
  spendPlatforms: string[];
  costPerDeal: ChannelCostPerDeal;
  cpa: ChannelCostPerDeal;
};

/**
 * The stage an approval is counted at, for cost per acquisition: UW approved
 * where the funnel has it — what the frozen channel figures and the ramp count
 * — else the stage before value. One rule, so the card, its chart and the
 * contract table cannot count approvals differently.
 */
export function approvalStageKey(stages: readonly StageDefinition[]): string | null {
  return stages.some((s) => s.key === 'uw_approved') ? 'uw_approved' : (stageBeforeValue(stages)?.key ?? null);
}

export function allSources(mp: MonthlyPerformance): AllSources {
  const value = mp.valueStageKey;
  const approval = approvalStageKey(mp.stages);
  const paid = mp.channels.filter((c) => isPaidChannel(c.platform));
  const adSpend = paid.reduce((sum, c) => sum + c.spend, 0);
  const deals = value ? (mp.total.stages[value] ?? 0) : 0;
  const approvals = approval ? (mp.total.stages[approval] ?? 0) : 0;
  return {
    deals,
    approvals,
    adSpend,
    spendPlatforms: paid.filter((c) => c.spend > 0).map((c) => c.platform),
    costPerDeal: allSourcesCostPer({ adSpend, deals }),
    cpa: allSourcesCostPer({ adSpend, deals: approvals }),
  };
}
