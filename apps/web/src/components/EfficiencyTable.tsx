import {
  formatCount,
  formatCurrency,
  type ChannelCostPerDeal,
  type PopulationVerdict,
} from '@zeeraa/core';
import { Card, CardHeader, EmptyLine } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';

export type EfficiencyCell = {
  /** The stage this cost is per — `lead`, `application`, `uw_approved`, `funded`. */
  stage: string;
  cost: ChannelCostPerDeal;
  /** Whether the denominator is large enough for the figure to mean anything. */
  gate: PopulationVerdict;
};

export type EfficiencyRow = {
  platform: string;
  label: string;
  spend: number;
  cells: EfficiencyCell[];
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
 * Deals no channel can claim get a row group below a heavier rule, badged
 * `Not a channel`. They have a count and no spend, so every cost cell is an em
 * dash with the reason — never a zero.
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
                    {formatCurrency(row.spend, currency)}
                  </td>
                  {columns.map((column) => {
                    const cell = row.cells.find((c) => c.stage === column.stage);
                    return (
                      <td key={column.stage} className="numeric px-3 py-3 align-top">
                        {cell ? (
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
                    <span className="flex flex-wrap items-center gap-2">
                      {unattributed.label}
                      <Badge tone="neutral">Not a channel</Badge>
                    </span>
                  </th>
                  <td className="numeric px-3 py-3 text-text-3" title={unattributed.reason}>
                    &mdash;
                  </td>
                  {columns.map((column) => (
                    <td key={column.stage} className="numeric px-3 py-3">
                      {/*
                        A count and an em dash, on purpose. These records exist
                        — that is the number — and no spend stands behind them,
                        so the cost cell is a category error rather than a zero.
                      */}
                      <span className="inline-flex items-center gap-1.5 text-text-3">
                        &mdash;
                        <InfoTip
                          label={`Why ${column.label} has no cost here`}
                          align="end"
                        >
                          {unattributed.reason}
                        </InfoTip>
                      </span>
                      <span className="mt-0.5 block text-[12px] tabular text-text-2">
                        {formatCount(unattributed.counts[column.stage] ?? 0)}{' '}
                        {column.label.toLowerCase()}
                      </span>
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
 * One cost cell: the figure, or the reason there is not one, with the coverage
 * that qualifies it underneath.
 *
 * Three states and they are genuinely different:
 *
 *   * a figure, with the population it divided by;
 *   * `Not measured`, where the population is too small for the figure to be
 *     about the channel rather than about the sample;
 *   * an em dash, where nothing at all was attributed — an empty denominator is
 *     not zero and not infinite.
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

  if (cell.cost.value === null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-text-3">
        &mdash;
        <InfoTip label={`Why ${channelLabel} has no cost per ${noun}`} align="end">
          {formatCurrency(cell.cost.channelSpend, currency)} of {channelLabel} spend and no{' '}
          {noun} the platform can attribute to it. A cost with nothing in the denominator is
          absent, not zero.
        </InfoTip>
      </span>
    );
  }

  if (!cell.gate.sufficient) {
    return (
      <span className="inline-flex flex-col items-end gap-0.5">
        <span className="inline-flex items-center gap-1.5">
          <Badge tone="warn">Not measured</Badge>
          <InfoTip label={`Why ${channelLabel} has no cost per ${noun}`} align="end">
            {cell.gate.reason} Over a population this small the figure measures the sample rather
            than {channelLabel}.
          </InfoTip>
        </span>
        <span className="text-[12px] tabular text-text-2">
          {formatCount(cell.cost.attributedDeals)} attributed
        </span>
      </span>
    );
  }

  const { low, high } = cell.cost.plausibleRange;
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <span className="inline-flex items-center gap-1.5 tabular text-text">
        {formatCurrency(cell.cost.value, currency)}
        <InfoTip label={`Coverage and range for ${channelLabel}, cost per ${noun}`} align="end">
          {formatCurrency(cell.cost.channelSpend, currency)} of {channelLabel} spend over the{' '}
          {formatCount(cell.cost.attributedDeals)} {noun}
          {cell.cost.attributedDeals === 1 ? '' : 's'} attributed to it — the only denominator this
          figure has.
          {cell.cost.unattributedDeals > 0 && low !== null && high !== null
            ? ` A further ${formatCount(cell.cost.unattributedDeals)} carry no click from any connected channel; the range is where the figure would land if every one of them turned out to be ${channelLabel}.`
            : ''}
        </InfoTip>
      </span>
      {/* Coverage under every figure, per cell. A cost per lead over 185 of
          1,457 leads and a cost per funded deal over 3 of 5 are supported to
          completely different degrees, and the row cannot say that once. */}
      <span className="text-[12px] tabular text-text-2">
        over {formatCount(cell.cost.attributedDeals)}
        {cell.cost.unattributedDeals > 0 && low !== null && high !== null ? (
          <>
            {' '}
            · to {formatCurrency(low, currency)}
          </>
        ) : null}
      </span>
    </span>
  );
}
