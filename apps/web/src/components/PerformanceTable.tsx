import { formatCount, formatCurrency, formatRate, noSpendNote, noSpendReason, sourceDescription } from '@zeeraa/core';
import { NotMeasuredBadge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { Progress } from '@/components/ui/Progress';
import { coverageExplanation, coverageLine } from '@/components/CostPerDeal';
import type { MonthlyPerformance, StageCounts } from '@/lib/reporting';

/**
 * The all-platforms table (spec v2 §6).
 *
 * The three row kinds are rendered by three blocks rather than one loop with
 * conditionals, which is the layout half of the separation rule. A channel row
 * and the unattributed row are not the same thing with some cells blank: one
 * describes money spent and what it bought, the other describes deals nobody
 * bought. Sharing a render path is how they end up sharing an interpretation.
 *
 * What spec v2 changed is the surface, not the arithmetic: unattributed is now
 * a visually distinct row group below a heavier rule carrying a grey
 * `Not a channel` badge, a blocked stage is an amber `Not measured` badge with
 * its reason in a tooltip, and the paragraphs that used to sit under the table
 * are gone — they live in the ⓘ icons and in the data-quality card.
 */

function Dash({ reason }: { reason: string }) {
  return (
    <span className="text-text-3" title={reason}>
      —
    </span>
  );
}

/**
 * A blocked stage renders its dependency, never a count. Nobody stamps that
 * timestamp in the CRM, so nothing reached it as far as the platform can tell —
 * and a zero would say the opposite: that the platform looked and found none.
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
        <td key={stage.key} className="numeric px-3 py-3">
          <span className="inline-flex items-center gap-1.5">
            <NotMeasuredBadge />
            <InfoTip label={`Why ${blocked.label} is not measured`} align="end">
              {blocked.reason}
              {blocked.needed ? ` Needed: ${blocked.needed}` : ''}
            </InfoTip>
          </span>
        </td>
      );
    }
    return (
      <td key={stage.key} className="numeric px-3 py-3 tabular text-text">
        {formatCount(counts[stage.key] ?? 0)}
      </td>
    );
  });
}

/**
 * A source with no ingested spend — SEO/Organic, or a lead vendor paid outside
 * the ad platforms. Its counts and volume are real; spend, impressions, clicks,
 * CTR, CPC and cost per deal do not apply, so they are one em dash with the
 * reason rather than a row of zeroes.
 */
function UnpaidRow({
  platform,
  label,
  stagesCells,
  volume,
}: {
  platform: string;
  label: string;
  stagesCells: React.ReactNode;
  volume: string;
}) {
  const about = sourceDescription(platform);
  return (
    <tr className="border-b border-border align-top transition-colors hover:bg-canvas">
      <th scope="row" className="px-5 py-3 text-left text-[13px] font-medium text-text">
        <span className="inline-flex items-center gap-1.5">
          {label}
          {about && (
            <InfoTip label={`What ${label} means`} align="start">
              {about}
            </InfoTip>
          )}
        </span>
      </th>
      <td className="numeric px-3 py-3" colSpan={5}>
        <span className="text-text-3">—</span>
        <span className="ml-2 text-[12px] text-text-2">{noSpendNote(platform)}</span>
      </td>
      {stagesCells}
      <td className="numeric px-3 py-3 tabular text-text">{volume}</td>
      <td className="numeric px-5 py-3">
        <span className="inline-flex items-center gap-1.5 text-text-3">
          —
          <InfoTip label={`Why ${label} has no cost per deal`} align="end">
            {noSpendReason(platform)}
          </InfoTip>
        </span>
      </td>
    </tr>
  );
}

export function PerformanceTable({
  data,
  currency,
}: {
  data: MonthlyPerformance;
  currency: string;
}) {
  const { stages, channels, unattributed, total } = data;
  const hasUnattributed = stages.some((s) => (unattributed.stages[s.key] ?? 0) > 0);
  const valueStage = stages.find((s) => s.countsValue);
  const widestCtr = Math.max(...channels.map((c) => c.ctr ?? 0), 0.0001);

  return (
    <div className="scroll-x min-w-0 overflow-x-auto border-t border-border">
      <table className="w-full min-w-max border-collapse text-[13px]">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-border text-left text-[12px] font-semibold text-text-2">
            <th scope="col" className="px-5 py-2.5 font-semibold">
              Channel
            </th>
            <th scope="col" className="numeric px-3 py-2.5 font-semibold">
              Spend
            </th>
            <th scope="col" className="numeric px-3 py-2.5 font-semibold">
              Impressions
            </th>
            <th scope="col" className="numeric px-3 py-2.5 font-semibold">
              Clicks
            </th>
            <th scope="col" className="px-3 py-2.5 font-semibold">
              CTR
            </th>
            <th scope="col" className="numeric px-3 py-2.5 font-semibold">
              CPC
            </th>
            {stages.map((stage) => (
              <th key={stage.key} scope="col" className="numeric px-3 py-2.5 font-semibold">
                <span className="inline-flex items-center gap-1.5">
                  {stage.isOptimizationTarget && (
                    <span
                      aria-hidden="true"
                      className="inline-block h-1.5 w-1.5 rounded-full bg-plot"
                      title="Optimisation target"
                    />
                  )}
                  {stage.label}
                  {data.stageStatus[stage.key]?.origin === 'computed' && (
                    <InfoTip label={`How ${stage.label} is established`} align="end">
                      This stage has no timestamp in the CRM and is computed by the platform from
                      the qualification bar. A computed stage is a different kind of fact from an
                      observed one.
                    </InfoTip>
                  )}
                  {data.stageStatus[stage.key]?.coverage && (
                    <InfoTip label={`What limits ${stage.label} coverage`} align="end">
                      Read from {data.stageStatus[stage.key]!.coverage!.source}, which starts on{' '}
                      {data.stageStatus[stage.key]!.coverage!.from.toISOString().slice(0, 10)}.
                      Transitions inside that window are recorded facts; anything earlier cannot be
                      read, so an earlier period is understated rather than low.
                    </InfoTip>
                  )}
                </span>
                {data.stageStatus[stage.key]?.origin === 'computed' && (
                  <span className="mt-0.5 block text-[11px] font-normal text-text-3">computed</span>
                )}
                {data.stageStatus[stage.key]?.coverage && (
                  <span className="mt-0.5 block text-[11px] font-normal tabular text-text-3">
                    from {data.stageStatus[stage.key]!.coverage!.from.toISOString().slice(0, 10)}
                  </span>
                )}
              </th>
            ))}
            <th scope="col" className="numeric px-3 py-2.5 font-semibold">
              {valueStage?.label ?? 'Funded'} volume
            </th>
            <th scope="col" className="numeric px-5 py-2.5 font-semibold">
              <span className="inline-flex items-center gap-1.5">
                Cost per {(valueStage?.label ?? 'funded').toLowerCase()} deal
                <InfoTip label="How cost per deal is measured" align="end">
                  A channel&rsquo;s spend over the deals attributed to that channel. Deals no
                  channel can claim are in no denominator, and the range under each figure is where
                  it would land if every one of them turned out to be that channel.
                </InfoTip>
              </span>
            </th>
          </tr>
        </thead>

        <tbody>
          {channels.map((row) =>
            !row.paid ? (
              <UnpaidRow
                key={row.platform}
                platform={row.platform}
                label={row.label}
                stagesCells={stageCells(stages, data.stageStatus, row.stages)}
                volume={formatCurrency(row.valueVolume, currency)}
              />
            ) : (
            <tr
              key={row.platform}
              className="border-b border-border align-top transition-colors hover:bg-canvas"
            >
              <th
                scope="row"
                className="px-5 py-3 text-left text-[13px] font-medium text-text"
              >
                {row.label}
              </th>
              <td className="numeric px-3 py-3 tabular text-text">
                {formatCurrency(row.spend, currency)}
              </td>
              <td className="numeric px-3 py-3 tabular text-text">
                {formatCount(row.impressions)}
              </td>
              <td className="numeric px-3 py-3 tabular text-text">{formatCount(row.clicks)}</td>
              <td className="px-3 py-3">
                {row.ctr === null ? (
                  <Dash reason="No impressions in this window." />
                ) : (
                  <span className="flex min-w-[96px] items-center gap-2">
                    <Progress
                      value={row.ctr / widestCtr}
                      label={`${row.label} click-through rate ${formatRate(row.ctr)}`}
                    />
                    <span className="shrink-0 tabular text-text">{formatRate(row.ctr)}</span>
                  </span>
                )}
              </td>
              <td className="numeric px-3 py-3 tabular text-text">
                {row.cpc === null ? (
                  <Dash reason="No clicks in this window." />
                ) : (
                  formatCurrency(row.cpc, currency)
                )}
              </td>
              {stageCells(stages, data.stageStatus, row.stages)}
              <td className="numeric px-3 py-3 tabular text-text">
                {formatCurrency(row.valueVolume, currency)}
              </td>
              <td className="numeric px-5 py-3">
                {row.costPerDeal.value === null ? (
                  <span className="text-[13px] text-text-3">No deals yet</span>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1.5 tabular font-medium text-text">
                      {formatCurrency(row.costPerDeal.value, currency)}
                      <InfoTip label={`How ${row.label}'s cost per deal is worked out`} align="end">
                        {coverageExplanation(row.costPerDeal, currency, row.label)}
                      </InfoTip>
                    </span>
                    <span className="mt-0.5 block text-[12px] tabular text-text-2">
                      {coverageLine(row.costPerDeal, currency)}
                    </span>
                  </>
                )}
              </td>
            </tr>
            ),
          )}
        </tbody>

        {/*
          Its own row group, below a heavier rule. Nobody bought these deals: a
          0 in a spend column against real funded deals would be a measurement
          claiming Zeeraa acquired them for nothing.
        */}
        {hasUnattributed && (
          <tbody className="border-t-2 border-text-3/40 bg-canvas">
            <tr className="align-top">
              <th scope="row" className="px-5 py-3 text-left font-medium text-text">
                <span className="flex flex-wrap items-center gap-2">
                  {unattributed.label}
                  <InfoTip label="What unattributed means" align="start">
                    {unattributed.reason}
                  </InfoTip>
                </span>
              </th>
              <td className="numeric px-3 py-3" colSpan={5}>
                <span className="text-text-3">—</span>
                <span className="ml-2 text-[12px] text-text-2">no spend stands behind these</span>
              </td>
              {stageCells(stages, data.stageStatus, unattributed.stages)}
              <td className="numeric px-3 py-3 tabular text-text">
                {formatCurrency(unattributed.valueVolume, currency)}
              </td>
              <td className="numeric px-5 py-3">
                <span className="inline-flex items-center gap-1.5 text-text-3">
                  —
                  <InfoTip label="Why these deals have no cost per deal" align="end">
                    {unattributed.reason}
                  </InfoTip>
                </span>
              </td>
            </tr>
          </tbody>
        )}

        <tfoot>
          <tr className="border-t-2 border-text align-top font-medium">
            <th scope="row" className="px-5 py-3 text-left font-semibold text-text">
              {total.label}
            </th>
            <td className="numeric px-3 py-3 tabular text-text">
              {formatCurrency(total.spend, currency)}
            </td>
            <td className="numeric px-3 py-3 tabular text-text">
              {formatCount(total.impressions)}
            </td>
            <td className="numeric px-3 py-3 tabular text-text">{formatCount(total.clicks)}</td>
            <td className="numeric px-3 py-3 tabular text-text">
              {total.ctr === null ? <Dash reason="No impressions." /> : formatRate(total.ctr)}
            </td>
            <td className="numeric px-3 py-3 tabular text-text">
              {total.cpc === null ? (
                <Dash reason="No clicks." />
              ) : (
                formatCurrency(total.cpc, currency)
              )}
            </td>
            {stageCells(stages, data.stageStatus, total.stages)}
            <td className="numeric px-3 py-3 tabular text-text">
              {formatCurrency(total.valueVolume, currency)}
            </td>
            <td className="numeric px-5 py-3">
              <span className="inline-flex items-center gap-1.5 text-text-3">
                —
                <InfoTip label="Why there is no blended cost per deal" align="end">
                  {total.costPerDealAbsentBecause}
                </InfoTip>
              </span>
            </td>
          </tr>
          <tr>
            <td colSpan={8 + stages.length} className="px-5 pb-3 pt-1">
              <p className="text-[12px] text-text-3">
                Total: spend across channels, deals across every source. Cost per deal does not
                sum.
              </p>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
