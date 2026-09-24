import { formatCount, formatRangeLabel } from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine } from '@/components/ui/Card';
import { InfoTip } from '@/components/ui/InfoTip';
import { MonthBars, type MonthBar } from '@/components/charts/MonthBars';
import { NO_REASON_BUCKET, share, type DeclineReasonSummary } from '@/lib/quality-measures';

/**
 * Declines: how many deals lenders turned down, by month, and the reasons
 * they gave — written for a client (24 September 2026).
 *
 * Two counts, named for what they count, because they differ by a factor of
 * two and were read as one: **deals declined** (a deal is one deal however
 * many lenders it went to) and **lender decline responses** (one deal sent to
 * three lenders that all said no is three). The bars are the deals, over the
 * picked window only, each deal in one month, so they add up to the headline.
 * The reasons come from `declineReasonSummary`, at lender grain.
 */
export function DeclineCard({
  bars,
  total,
  range,
  reasons,
  span,
}: {
  bars: MonthBar[];
  /** Distinct deals declined in the range. */
  total: number;
  range: { start: string; end: string };
  reasons: DeclineReasonSummary;
  /** Omitted inside a column of its own (the funnel), where a span would do nothing. */
  span?: 4 | 6 | 8 | 12;
}) {
  const top = reasons.reasons.slice(0, 5);
  const most = Math.max(reasons.noReason, ...top.map((r) => r.count), 1);

  return (
    <Card span={span}>
      <CardHeader title="Declines" subtitle="Deals lenders turned down, by month" />

      <CardBody className="flex-1">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <div>
              <p className="flex items-center gap-1.5 text-[13px] font-medium text-text-2">
                Deals declined
                <InfoTip label="What deals declined counts" align="start">
                  Each deal counts once, however many lenders it went to and even if it was declined,
                  reopened and declined again. The bars are these deals, by month.
                </InfoTip>
              </p>
              <p className="mt-1 text-[28px] font-semibold leading-[1.15] tabular text-text">
                {formatCount(total)}
              </p>
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-[13px] font-medium text-text-2">
                Lender decline responses
                <InfoTip label="What lender decline responses counts" align="start">
                  One per lender that said no. One deal sent to three lenders is one deal, three
                  responses.
                </InfoTip>
              </p>
              <p className="mt-1 text-[28px] font-semibold leading-[1.15] tabular text-text-2">
                {formatCount(reasons.declined)}
              </p>
            </div>
            <p className="basis-full text-[13px] tabular text-text-2">{formatRangeLabel(range)}</p>
          </div>

          <div className="min-w-[240px] flex-1">
            {total === 0 ? (
              <EmptyLine>No deals declined in this period.</EmptyLine>
            ) : (
              <MonthBars id="declines-per-month" bars={bars} noun={['deal declined', 'deals declined']} height={150} />
            )}
          </div>
        </div>
      </CardBody>

      <div className="border-t border-border px-5 py-3">
        <p className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-medium text-text">Top reasons lenders gave</span>
          <InfoTip label="How reasons are counted" align="start">
            Counted per lender, so a deal sent to three lenders can be declined three times, and one
            decline can give more than one reason.
          </InfoTip>
        </p>
        {reasons.declined === 0 ? (
          <EmptyLine className="mt-1">No lender decline responses in this period.</EmptyLine>
        ) : (
          <>
            <p className="mt-0.5 text-[13px] tabular text-text-2">
              Reason given on {share(reasons.withReason, reasons.declined)} of{' '}
              {formatCount(reasons.declined)} lender decline responses
            </p>
            <ul className="mt-2 space-y-1.5">
              {top.map((row) => (
                <ReasonRow key={row.label} label={row.label} count={row.count} most={most} />
              ))}
              <ReasonRow label={`${NO_REASON_BUCKET} (no reason given)`} count={reasons.noReason} most={most} muted />
            </ul>
          </>
        )}
      </div>
    </Card>
  );
}

function ReasonRow({ label, count, most, muted = false }: { label: string; count: number; most: number; muted?: boolean }) {
  return (
    <li className="flex items-center gap-3">
      <span className={`min-w-0 flex-1 truncate text-[13px] ${muted ? 'text-text-2' : 'text-text'}`} title={label}>
        {label}
      </span>
      <span aria-hidden="true" className="h-1.5 w-[84px] shrink-0 overflow-hidden rounded-[2px] bg-canvas">
        <span
          className={`block h-full ${muted ? 'bg-text-3' : 'bg-primary'}`}
          style={{ width: `${Math.max(4, (count / most) * 100)}%` }}
        />
      </span>
      <span className="w-10 shrink-0 text-right text-[13px] tabular text-text">{formatCount(count)}</span>
    </li>
  );
}
