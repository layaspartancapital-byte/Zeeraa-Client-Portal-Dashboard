import { AD_DETAIL, formatCount, formatCurrency } from '@zeeraa/core';
import { Card, CardHeader, EmptyLine, CardBody } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import type { FundedDeal } from '@/lib/funded-deals';

/** A tenant-local day, as a date — never shifted through a timezone. */
function day(value: string): string {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function NotRecorded() {
  return <span className="text-text-3">Not recorded</span>;
}

/**
 * The deals behind this page's funded count, one row each (`lib/funded-deals.ts`).
 * Rendered only on a platform that names a keyword or an ad (`AD_DETAIL`).
 */
export function FundedDealsCard({
  platform,
  label,
  stageLabel,
  deals,
  currency,
}: {
  platform: string;
  label: string;
  stageLabel: string;
  deals: FundedDeal[];
  currency: string;
}) {
  const detail = AD_DETAIL[platform]!;
  return (
    <Card span={12}>
      <CardHeader
        title={`${stageLabel} deals`}
        subtitle={`${formatCount(deals.length)} ${deals.length === 1 ? 'deal' : 'deals'} attributed to ${label} in this period`}
        info={
          <InfoTip label="Where each column comes from" align="start">
            The deal, date and amount are Salesforce&rsquo;s; the campaign is the one attribution
            credits, or marked URL tag where it credits none and the lead&rsquo;s landing URL named
            one. The {detail.label.toLowerCase()} is from that landing URL too.
          </InfoTip>
        }
      />
      {deals.length === 0 ? (
        <CardBody>
          <EmptyLine>No {stageLabel.toLowerCase()} deal is attributed to {label} in this period.</EmptyLine>
        </CardBody>
      ) : (
        <div className="scroll-x min-w-0 overflow-x-auto border-t border-border">
          <table className="w-full min-w-[760px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[12px] font-semibold text-text-2">
                <th scope="col" className="px-5 py-2.5">Deal</th>
                <th scope="col" className="px-3 py-2.5">{stageLabel}</th>
                <th scope="col" className="numeric px-3 py-2.5">Amount</th>
                <th scope="col" className="px-3 py-2.5">Campaign</th>
                <th scope="col" className="px-5 py-2.5">{detail.label}</th>
              </tr>
            </thead>
            <tbody>
              {deals.map((deal) => (
                <tr key={deal.opportunityId} className="border-b border-border last:border-b-0">
                  <th scope="row" className="max-w-[260px] truncate px-5 py-3 text-left font-medium text-text">
                    {deal.name ?? <NotRecorded />}
                  </th>
                  <td className="whitespace-nowrap px-3 py-3 tabular text-text-2">{day(deal.fundedOn)}</td>
                  <td className="numeric px-3 py-3 tabular text-text">
                    {deal.fundedAmount === null ? <NotRecorded /> : formatCurrency(deal.fundedAmount, currency)}
                  </td>
                  <td className="max-w-[280px] px-3 py-3 text-text-2">
                    {deal.campaign === null ? (
                      <NotRecorded />
                    ) : (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 truncate" title={deal.campaign}>
                          {deal.campaign}
                        </span>
                        {deal.campaignFromTag && (
                          <Badge
                            tone="neutral"
                            className="px-1.5 py-0 text-[11px] font-medium"
                            title="From the lead's landing-URL campaign tag (utm_campaign); the click lookup found no campaign."
                          >
                            URL tag
                          </Badge>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="max-w-[240px] truncate px-5 py-3 text-text-2">
                    {deal.detail ?? <NotRecorded />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
