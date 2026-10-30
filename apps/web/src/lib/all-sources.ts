import { blendedCostPer, isPaidChannel, stageBeforeValue, type ChannelCostPerDeal } from '@zeeraa/core';
import type { MonthlyPerformance } from '@/lib/reporting';

/**
 * Executive's "All sources" card: the period's deals from every source, every
 * ad platform's spend, and the two blended costs between them (30 October
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

export function allSources(mp: MonthlyPerformance): AllSources {
  const value = mp.valueStageKey;
  const approval = stageBeforeValue(mp.stages)?.key ?? null;
  const paid = mp.channels.filter((c) => isPaidChannel(c.platform));
  const adSpend = paid.reduce((sum, c) => sum + c.spend, 0);
  const deals = value ? (mp.total.stages[value] ?? 0) : 0;
  const approvals = approval ? (mp.total.stages[approval] ?? 0) : 0;
  return {
    deals,
    approvals,
    adSpend,
    spendPlatforms: paid.filter((c) => c.spend > 0).map((c) => c.platform),
    costPerDeal: blendedCostPer({ adSpend, deals }),
    cpa: blendedCostPer({ adSpend, deals: approvals }),
  };
}
