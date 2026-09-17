import { formatCount, formatCurrency, formatRate } from '@zeeraa/core';
import { CostPerDealCell, NoCostPerDealCell } from '@/components/CostPerDeal';
import type { MonthlyPerformance, StageCounts } from '@/lib/reporting';

/**
 * One row per channel, then the unattributed row, then totals.
 *
 * The three row kinds are rendered by three functions rather than one loop with
 * conditionals, which is the layout half of the separation rule. A channel row
 * and the unattributed row are not the same thing with some cells blank: one
 * describes money spent and what it bought, the other describes deals nobody
 * bought. Sharing a render path is how they end up sharing an interpretation.
 */

function Dash({ reason }: { reason: string }) {
  return (
    <span className="text-provisional" title={reason}>
      —
    </span>
  );
}

/**
 * Stage cells.
 *
 * A blocked stage renders its dependency, never a count. Nobody stamps that
 * timestamp in the CRM, so nothing reached it as far as the platform can tell —
 * and a zero would say the opposite of that, that the platform looked and found
 * none. The distinction is the whole of §9.5.
 */
function stageCells(
  stages: MonthlyPerformance['stages'],
  status: MonthlyPerformance['stageStatus'],
  counts: StageCounts,
) {
  return stages.map((stage) => {
    const blocked = status[stage.key]?.blocked;
    if (blocked) {
      return (
        <td key={stage.key} className="numeric px-3 py-2.5 align-top">
          <Dash reason={`${blocked.label} is not measured. ${blocked.reason}`} />
          <span className="mt-0.5 block text-[11px] text-graphite">not measured</span>
        </td>
      );
    }
    return (
      <td key={stage.key} className="numeric px-3 py-2.5 align-top text-ink">
        {formatCount(counts[stage.key] ?? 0)}
      </td>
    );
  });
}

export function PerformanceTable({ data, currency }: { data: MonthlyPerformance; currency: string }) {
  const { stages, channels, unattributed, total } = data;
  const columnCount = 6 + stages.length + 2;

  const hasUnattributed = stages.some((s) => (unattributed.stages[s.key] ?? 0) > 0);
  const blockedStages = stages
    .map((s) => data.stageStatus[s.key])
    .filter((s): s is NonNullable<typeof s> => Boolean(s?.blocked));

  return (
    <div className="table-scroll overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-rule text-left text-[11px] text-graphite">
            <th scope="col" className="px-3 py-2 font-medium">
              Channel
            </th>
            <th scope="col" className="numeric px-3 py-2 font-medium">
              Spend
            </th>
            <th scope="col" className="numeric px-3 py-2 font-medium">
              Impressions
            </th>
            <th scope="col" className="numeric px-3 py-2 font-medium">
              Clicks
            </th>
            <th scope="col" className="numeric px-3 py-2 font-medium">
              CTR
            </th>
            <th scope="col" className="numeric px-3 py-2 font-medium">
              CPC
            </th>
            {stages.map((stage) => (
              <th key={stage.key} scope="col" className="numeric px-3 py-2 font-medium">
                <span className={stage.isOptimizationTarget ? 'border-b-2 border-brass pb-0.5' : ''}>
                  {stage.label}
                </span>
                {/* A computed stage is not an observed one, and says so
                    wherever it appears. */}
                {data.stageStatus[stage.key]?.origin === 'computed' && (
                  <span className="mt-0.5 block font-normal text-[10px] text-provisional">
                    computed
                  </span>
                )}
              </th>
            ))}
            <th scope="col" className="numeric px-3 py-2 font-medium">
              Funded volume
            </th>
            <th scope="col" className="numeric px-3 py-2 font-medium">
              Cost per funded deal
            </th>
          </tr>
        </thead>

        <tbody>
          {channels.map((row) => (
            <tr key={row.platform} className="border-b border-rule align-top">
              <th scope="row" className="px-3 py-2.5 text-left font-normal text-ink">
                {row.label}
              </th>
              <td className="numeric px-3 py-2.5 text-ink">
                {formatCurrency(row.spend, currency)}
              </td>
              <td className="numeric px-3 py-2.5 text-ink">{formatCount(row.impressions)}</td>
              <td className="numeric px-3 py-2.5 text-ink">{formatCount(row.clicks)}</td>
              <td className="numeric px-3 py-2.5 text-ink">
                {row.ctr === null ? <Dash reason="No impressions in this period." /> : formatRate(row.ctr)}
              </td>
              <td className="numeric px-3 py-2.5 text-ink">
                {row.cpc === null ? (
                  <Dash reason="No clicks in this period." />
                ) : (
                  formatCurrency(row.cpc, currency)
                )}
              </td>
              {stageCells(stages, data.stageStatus, row.stages)}
              <td className="numeric px-3 py-2.5 text-ink">
                {formatCurrency(row.valueVolume, currency)}
              </td>
              <CostPerDealCell cost={row.costPerDeal} currency={currency} />
            </tr>
          ))}

          {/*
            Not a channel. It sits below every channel and above the total, with
            its spend columns struck through rather than zeroed: nobody bought
            these deals, and a 0 in a spend column against real funded deals
            would read as an acquisition cost of nothing.
          */}
          {hasUnattributed && (
            <tr className="border-b border-rule bg-paper/60 align-top">
              <th scope="row" className="px-3 py-2.5 text-left font-normal text-ink">
                {unattributed.label}
                <span className="mt-0.5 block text-[11px] text-graphite">not a channel</span>
              </th>
              <td className="numeric px-3 py-2.5" colSpan={5}>
                <span className="text-provisional">—</span>
                <span className="ml-2 text-[11px] text-graphite">no spend stands behind these</span>
              </td>
              {stageCells(stages, data.stageStatus, unattributed.stages)}
              <td className="numeric px-3 py-2.5 text-ink">
                {formatCurrency(unattributed.valueVolume, currency)}
              </td>
              <NoCostPerDealCell reason={unattributed.reason} />
            </tr>
          )}
        </tbody>

        <tfoot>
          <tr className="border-t-2 border-ink align-top">
            <th scope="row" className="px-3 py-2.5 text-left font-medium text-ink">
              {total.label}
            </th>
            <td className="numeric px-3 py-2.5 text-ink">
              {formatCurrency(total.spend, currency)}
            </td>
            <td className="numeric px-3 py-2.5 text-ink">{formatCount(total.impressions)}</td>
            <td className="numeric px-3 py-2.5 text-ink">{formatCount(total.clicks)}</td>
            <td className="numeric px-3 py-2.5 text-ink">
              {total.ctr === null ? <Dash reason="No impressions." /> : formatRate(total.ctr)}
            </td>
            <td className="numeric px-3 py-2.5 text-ink">
              {total.cpc === null ? (
                <Dash reason="No clicks." />
              ) : (
                formatCurrency(total.cpc, currency)
              )}
            </td>
            {stageCells(stages, data.stageStatus, total.stages)}
            <td className="numeric px-3 py-2.5 text-ink">
              {formatCurrency(total.valueVolume, currency)}
            </td>
            <NoCostPerDealCell reason={total.costPerDealAbsentBecause} />
          </tr>
        </tfoot>
      </table>

      <div className="border-t border-rule px-3 py-3">
        <p className="max-w-prose text-[11px] leading-relaxed text-graphite">
          <span className="text-ink">Totals.</span> Spend adds across channels and deals add across
          every source. Cost per funded deal does not add, and dividing one total by the other is a
          different metric. {total.costPerDealAbsentBecause}
        </p>
        {hasUnattributed && (
          <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-graphite">
            <span className="text-ink">Unattributed.</span> {unattributed.reason}
          </p>
        )}
        {blockedStages.map((stage) => (
          <p key={stage.key} className="mt-2 max-w-prose text-[11px] leading-relaxed text-graphite">
            <span className="text-ink">{stage.blocked!.label} is not measured.</span>{' '}
            {stage.blocked!.reason}
            {stage.blocked!.needed && (
              <>
                {' '}
                <span className="text-ink">Needed:</span> {stage.blocked!.needed}
              </>
            )}
            <span className="text-provisional">
              {' '}
              · outstanding since {stage.blocked!.since.toISOString().slice(0, 10)}
            </span>
          </p>
        ))}
      </div>

      <span className="sr-only">{columnCount} columns</span>
    </div>
  );
}
