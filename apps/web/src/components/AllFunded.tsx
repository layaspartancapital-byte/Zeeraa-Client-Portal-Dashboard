import { currencyFormatterFor, formatCount, formatCurrency } from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine } from '@/components/ui/Card';
import { InfoTip } from '@/components/ui/InfoTip';
import { NotMeasuredBadge } from '@/components/ui/Badge';

export type FundedSourceRow = {
  key: string;
  label: string;
  deals: number;
  volume: number;
  /** One sentence on what this source is, for its ⓘ. */
  info?: string;
};

/**
 * Every funded deal in the period, and where each one came from.
 *
 * The scorecard beneath is one channel against its contract; this is the
 * business's whole month, so a reader does not take Google Ads' deals for the
 * total. The rows are the total's partition — each deal is in exactly one —
 * which is why they add up to it, and why the page passes the report's own
 * channel and unattributed rows rather than recounting anything.
 */
export function AllFunded({
  title,
  periodLabel,
  valueLabel,
  totalDeals,
  totalVolume,
  rows,
  currency,
  notMeasured,
}: {
  title: string;
  periodLabel: string;
  /** The value stage's label — `Funded`. */
  valueLabel: string;
  totalDeals: number;
  totalVolume: number;
  rows: FundedSourceRow[];
  currency: string;
  /** Why the period cannot be counted. The named state, never a zero. */
  notMeasured?: string;
}) {
  const noun = (n: number) => (n === 1 ? 'deal' : 'deals');
  // One rule for the whole column, so a $0 row does not read "$0.00" beside "$10,000".
  const volume = currencyFormatterFor([totalVolume, ...rows.map((r) => r.volume)], currency);
  return (
    <Card span={12} id="all-funded">
      <CardHeader
        title={title}
        subtitle={`Every source · ${periodLabel}`}
        info={
          <InfoTip label={`How ${title.toLowerCase()} is counted`} align="start">
            Every deal reaching {valueLabel.toLowerCase()} in the period, renewals excluded, split
            by where it came from. Each deal is in one row, so the rows add up to the total.
          </InfoTip>
        }
      />
      {notMeasured ? (
        <CardBody>
          <EmptyLine action={<NotMeasuredBadge />}>{notMeasured}</EmptyLine>
        </CardBody>
      ) : (
        <div className="grid min-w-0 grid-cols-1 border-t border-border md:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
          <dl className="grid grid-cols-2 gap-4 px-5 py-4 md:grid-cols-1 md:border-r md:border-border">
            <div>
              <dt className="text-[13px] font-medium text-text-2">{valueLabel} deals</dt>
              <dd className="mt-1 text-[28px] font-semibold leading-[1.15] tabular text-text">
                {formatCount(totalDeals)}
              </dd>
            </div>
            <div>
              <dt className="text-[13px] font-medium text-text-2">{valueLabel} volume</dt>
              <dd className="mt-1 text-[28px] font-semibold leading-[1.15] tabular text-text">
                {formatCurrency(totalVolume, currency)}
              </dd>
            </div>
          </dl>
          <div className="min-w-0">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-[12px] font-semibold text-text-2">
                  <th scope="col" className="px-5 py-2.5 font-semibold">
                    Source
                  </th>
                  <th scope="col" className="numeric px-3 py-2.5 font-semibold">
                    Deals
                  </th>
                  <th scope="col" className="numeric px-5 py-2.5 font-semibold">
                    Volume
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-b border-border last:border-b-0">
                    <th scope="row" className="px-5 py-2.5 text-left font-medium text-text">
                      <span className="inline-flex items-center gap-1.5">
                        {row.label}
                        {row.info && (
                          <InfoTip label={`What ${row.label} means`} align="start">
                            {row.info}
                          </InfoTip>
                        )}
                      </span>
                    </th>
                    <td className="numeric px-3 py-2.5 tabular text-text">
                      {formatCount(row.deals)}
                      <span className="sr-only"> {noun(row.deals)}</span>
                    </td>
                    <td className="numeric px-5 py-2.5 tabular text-text">
                      {volume(row.volume)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}
