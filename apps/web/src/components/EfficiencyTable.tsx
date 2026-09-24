import {
  formatCount,
  formatCurrency,
  type ChannelCostPerDeal,
} from '@zeeraa/core';
import { Card, CardHeader, EmptyLine } from '@/components/ui/Card';
import { InfoTip } from '@/components/ui/InfoTip';

export type EfficiencyCell = {
  /** The stage this cost is per — `lead`, `application`, `uw_approved`, `funded`. */
  stage: string;
  cost: ChannelCostPerDeal;
};

export type EfficiencyRow = {
  platform: string;
  label: string;
  spend: number;
  cells: EfficiencyCell[];
  /**
   * Set for a source that buys nothing — organic search. Its row shows counts
   * and an em dash with this reason where a paid channel shows costs.
   */
  unpaidReason?: string;
};

/**
 * Cost per stage, per channel, with each figure's coverage under it.
 *
 * **A table rather than a row of KPI cards, because the metric is per channel.**
 * Cost per lead is that channel's spend over the leads attributed to that
 * channel; four metrics across two channels is eight cards, and the single
 * blended card that would fit the space is the thing the separation rule
 * exists to prevent — a figure that improves when a different channel has a
 * good month. One row per channel makes the scoping visible instead of
 * trusting a reader to remember it.
 *
 * Every cell carries its own coverage, because coverage differs per cell and
 * not merely per channel: Google Ads can claim 185 of this month's leads and
 * one of its funded deals, and those two figures are supported to completely
 * different degrees. A single coverage number for the row would average them
 * and hide exactly the thing worth seeing.
 *
 * An unpaid source (organic search) and the deals no channel can claim both
 * have counts and no spend, so every cost cell is an em dash with the reason
 * and the count beneath — never a zero. Unattributed sits below a heavier
 * rule, because it is what nobody can claim rather than a source.
 */
export function EfficiencyTable({
  rows,
  columns,
  unattributed,
  currency,
  periodLabel,
  span = 12,
}: {
  rows: EfficiencyRow[];
  /** Stage key to column heading, in funnel order. */
  columns: { stage: string; label: string }[];
  /** Counts per stage for the deals no channel can claim. */
  unattributed: { label: string; reason: string; counts: Record<string, number> };
  currency: string;
  periodLabel: string;
  span?: 8 | 12;
}) {
  const anyUnattributed = columns.some((c) => (unattributed.counts[c.stage] ?? 0) > 0);

  return (
    <Card span={span} selfStart>
      <CardHeader
        title="Efficiency"
        subtitle={`What each stage costs, per channel · ${periodLabel}`}
        info={
          <InfoTip label="How cost per stage is measured" align="start">
            Each figure is one channel&rsquo;s spend over the records attributed to
            that channel at that stage. Nothing here is blended across channels,
            and records no channel can claim are counted separately rather than
            being divided into anybody&rsquo;s spend.
          </InfoTip>
        }
      />

      {rows.length === 0 ? (
        <div className="px-5 pb-5">
          <EmptyLine>No channel has reported spend in this period.</EmptyLine>
        </div>
      ) : (
        <div className="scroll-x min-w-0 overflow-x-auto border-t border-border">
          <table className="w-full min-w-[720px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[12px] font-semibold text-text-2">
                <th scope="col" className="px-5 py-2.5 font-semibold">
                  Channel
                </th>
                <th scope="col" className="numeric px-3 py-2.5 font-semibold">
                  Spend
                </th>
                {columns.map((column) => (
                  <th key={column.stage} scope="col" className="numeric px-3 py-2.5 font-semibold">
                    Cost per {column.label.toLowerCase()}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.platform}
                  className="border-b border-border transition-colors last:border-b-0 hover:bg-canvas"
                >
                  <th
                    scope="row"
                    className="px-5 py-3 text-left align-top text-[13px] font-medium text-text"
                  >
                    {row.label}
                  </th>
                  <td className="numeric px-3 py-3 align-top tabular text-text">
                    {row.unpaidReason ? (
                      <span className="text-text-3" title={row.unpaidReason}>
                        &mdash;
                      </span>
                    ) : (
                      formatCurrency(row.spend, currency)
                    )}
                  </td>
                  {columns.map((column) => {
                    const cell = row.cells.find((c) => c.stage === column.stage);
                    return (
                      <td key={column.stage} className="numeric px-3 py-3 align-top">
                        {row.unpaidReason ? (
                          <CountOnlyCell
                            stage={column.stage}
                            stageLabel={column.label}
                            count={cell?.cost.attributedDeals ?? 0}
                            reason={row.unpaidReason}
                          />
                        ) : cell ? (
                          <CostCell
                            cell={cell}
                            currency={currency}
                            channelLabel={row.label}
                            stageLabel={column.label}
                          />
                        ) : (
                          <span className="text-text-3">&mdash;</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>

            {anyUnattributed && (
              <tfoot>
                <tr className="border-t-2 border-text-3/40 bg-canvas align-top">
                  <th scope="row" className="px-5 py-3 text-left font-medium text-text">
                    {unattributed.label}
                  </th>
                  <td className="numeric px-3 py-3 text-text-3" title={unattributed.reason}>
                    &mdash;
                  </td>
                  {columns.map((column) => (
                    <td key={column.stage} className="numeric px-3 py-3">
                      <CountOnlyCell
                        stage={column.stage}
                        stageLabel={column.label}
                        count={unattributed.counts[column.stage] ?? 0}
                        reason={unattributed.reason}
                      />
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </Card>
  );
}

/**
 * What a cost was divided by, in the client's words: `230 leads`, `1 deal`.
 * Plural and singular written out, because "1 deals" is the small wrongness
 * that makes a reader distrust the number beside it.
 */
const COUNT_NOUNS: Record<string, readonly [string, string]> = {
  lead: ['lead', 'leads'],
  application: ['application', 'applications'],
  uw_approved: ['approval', 'approvals'],
};
function countNoun(stage: string, n: number): string {
  const [one, many] = COUNT_NOUNS[stage] ?? (['deal', 'deals'] as const);
  return n === 1 ? one : many;
}

/**
 * A count and an em dash, on purpose. These records exist — that is the
 * number — and no spend stands behind them, so the cost cell is a category
 * error rather than a zero.
 */
function CountOnlyCell({
  stage,
  stageLabel,
  count,
  reason,
}: {
  stage: string;
  stageLabel: string;
  count: number;
  reason: string;
}) {
  return (
    <>
      <span className="inline-flex items-center gap-1.5 text-text-3">
        &mdash;
        <InfoTip label={`Why ${stageLabel} has no cost here`} align="end">
          {reason}
        </InfoTip>
      </span>
      <span className="mt-0.5 block text-[12px] tabular text-text-2">
        {formatCount(count)} {countNoun(stage, count)}
      </span>
    </>
  );
}

/**
 * One cost cell: the figure, and under it what it was divided by — always, at
 * any size (the minimum-deal rule no longer applies to costs; see
 * `packages/core/src/population.ts`). Only an empty denominator has no figure,
 * and it says "No deals yet" rather than a dash.
 */
function CostCell({
  cell,
  currency,
  channelLabel,
  stageLabel,
}: {
  cell: EfficiencyCell;
  currency: string;
  channelLabel: string;
  stageLabel: string;
}) {
  const noun = stageLabel.toLowerCase();
  const n = cell.cost.attributedDeals;

  if (cell.cost.value === null || n === 0) {
    return <span className="text-[13px] text-text-3">No {countNoun(cell.stage, 2)} yet</span>;
  }

  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <span className="inline-flex items-center gap-1.5 tabular text-text">
        {formatCurrency(cell.cost.value, currency)}
        <InfoTip label={`How ${channelLabel}'s cost per ${noun} is worked out`} align="end">
          {formatCurrency(cell.cost.channelSpend, currency)} of {channelLabel} spend divided by the{' '}
          {formatCount(n)} {countNoun(cell.stage, n)} that came from {channelLabel}.
        </InfoTip>
      </span>
      <span className="text-[12px] tabular text-text-2">
        {formatCount(n)} {countNoun(cell.stage, n)}
      </span>
    </span>
  );
}
