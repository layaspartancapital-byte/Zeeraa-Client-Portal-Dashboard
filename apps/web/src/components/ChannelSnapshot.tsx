import { formatCount, formatCurrency } from '@zeeraa/core';
import { Card, CardHeader, EmptyLine } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { Progress } from '@/components/ui/Progress';
import { coverageExplanation } from '@/components/CostPerDeal';
import type { MonthlyPerformance } from '@/lib/reporting';

/**
 * One row per connected channel: spend, funded deals, cost per deal, coverage.
 *
 * The coverage bar is the point of the card. A cost per deal on its own invites
 * the reader to compare two channels as though both figures were equally well
 * supported; the bar says what share of the period's funded deals each channel
 * can actually speak for.
 *
 * Deals no channel can claim sit in their own row group below a heavier rule,
 * with a grey badge and a dash wherever a spend-derived figure would go. They
 * are not a channel, they never enter a channel's denominator, and they do not
 * share a line with one.
 */
export function ChannelSnapshot({
  data,
  currency,
  valueLabel,
  span = 8,
}: {
  data: MonthlyPerformance;
  currency: string;
  valueLabel: string;
  span?: 6 | 8 | 12;
}) {
  const valueStage = data.stages.find((s) => s.countsValue);
  const dealsOf = (stages: Record<string, number>) =>
    valueStage ? (stages[valueStage.key] ?? 0) : 0;

  const totalDeals = dealsOf(data.total.stages);
  const unattributedDeals = dealsOf(data.unattributed.stages);

  return (
    <Card span={span} selfStart>
      <CardHeader
        title="Channel snapshot"
        subtitle={`Spend and ${valueLabel.toLowerCase()} deals per connected channel`}
      />

      {data.channels.length === 0 ? (
        <div className="px-5 pb-5">
          <EmptyLine>No channel has reported spend in this window.</EmptyLine>
        </div>
      ) : (
        <div className="scroll-x min-w-0 overflow-x-auto border-t border-border">
          <table className="w-full min-w-[600px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[12px] font-semibold text-text-2">
                <th scope="col" className="px-5 py-2.5 font-semibold">
                  Channel
                </th>
                <th scope="col" className="numeric px-3 py-2.5 font-semibold">
                  Spend
                </th>
                <th scope="col" className="numeric px-3 py-2.5 font-semibold">
                  {valueLabel} deals
                </th>
                <th scope="col" className="numeric px-3 py-2.5 font-semibold">
                  Cost per deal
                </th>
                <th scope="col" className="px-5 py-2.5 font-semibold">
                  <span className="inline-flex items-center gap-1.5">
                    Coverage
                    <InfoTip label="What coverage means" align="end">
                      The share of this window&rsquo;s {valueLabel.toLowerCase()} deals this
                      channel can account for. The rest carry no click from any connected channel
                      and are in no channel&rsquo;s denominator.
                    </InfoTip>
                  </span>
                </th>
              </tr>
            </thead>

            <tbody>
              {data.channels.map((channel) => {
                const deals = dealsOf(channel.stages);
                const coverage = totalDeals === 0 ? 0 : deals / totalDeals;
                return (
                  <tr
                    key={channel.platform}
                    className="border-b border-border transition-colors last:border-b-0 hover:bg-canvas"
                  >
                    <th
                      scope="row"
                      className="px-5 py-3 text-left text-[13px] font-medium text-text"
                    >
                      {channel.label}
                    </th>
                    <td className="numeric px-3 py-3 tabular text-text">
                      {formatCurrency(channel.spend, currency)}
                    </td>
                    <td className="numeric px-3 py-3 tabular text-text">{formatCount(deals)}</td>
                    <td className="numeric px-3 py-3 tabular text-text">
                      {channel.costPerDeal.value === null ? (
                        <span className="text-text-3" title="No attributed deal in this window.">
                          —
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          {formatCurrency(channel.costPerDeal.value, currency)}
                          <InfoTip
                            label={`Coverage and range for ${channel.label}`}
                            align="end"
                          >
                            {coverageExplanation(channel.costPerDeal, currency, channel.label)}
                          </InfoTip>
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span className="flex items-center gap-2">
                        <Progress
                          value={coverage}
                          label={`${channel.label} accounts for ${formatCount(deals)} of ${formatCount(totalDeals)} deals`}
                        />
                        <span className="shrink-0 text-[12px] tabular text-text-2">
                          {formatCount(deals)}/{formatCount(totalDeals)}
                        </span>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>

            {unattributedDeals > 0 && (
              <tfoot>
                <tr className="border-t-2 border-text-3/40 bg-canvas">
                  <th scope="row" className="px-5 py-3 text-left font-medium text-text">
                    <span className="flex flex-wrap items-center gap-2">
                      {data.unattributed.label}
                      <Badge tone="neutral">Not a channel</Badge>
                    </span>
                  </th>
                  <td className="numeric px-3 py-3 text-text-3" title={data.unattributed.reason}>
                    —
                  </td>
                  <td className="numeric px-3 py-3 tabular text-text">
                    {formatCount(unattributedDeals)}
                  </td>
                  <td className="numeric px-3 py-3">
                    <span className="inline-flex items-center gap-1.5 text-text-3">
                      —
                      <InfoTip label="Why these deals have no cost per deal" align="end">
                        {data.unattributed.reason}
                      </InfoTip>
                    </span>
                  </td>
                  <td className="px-5 py-3 text-[12px] text-text-2 tabular">
                    {formatCount(unattributedDeals)}/{formatCount(totalDeals)} of deals
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </Card>
  );
}
