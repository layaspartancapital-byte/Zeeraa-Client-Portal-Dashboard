import { formatCount, formatRate, type PopulationVerdict } from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import type { SubmissionReport } from '@/lib/reporting';

/**
 * Lender outcomes, at the grain the decisions happen.
 *
 * A deal is shopped to several lenders at once — Spartan's median is four — and
 * each lender answers separately. The deal-level offer rate this replaces
 * divided two counts of the same event and read 58.8%; a lender's answers over
 * that lender's decisions reads 18.2%.
 *
 * Two rules govern the table:
 *
 *   - **Both halves of a rate come from the same lender.** Exactly the rule
 *     channel metrics follow. Summing offers across lenders over one lender's
 *     decisions would make a lender look better when a different one had a good
 *     month.
 *   - **Undecided submissions are on the card, not in a caption.** They are the
 *     majority at any moment, so a reader who assumes the denominator is every
 *     submission is out by a factor of two. They are never a soft no.
 */
export function LenderOutcomes({
  report,
  span,
  gateFor,
}: {
  report: SubmissionReport;
  span?: 4 | 6 | 8 | 12;
  /**
   * The verdict for an offer rate over this many decided submissions, from
   * `metrics.population('submission_offer_rate', n)`. A lender with two
   * decisions shows its counts and withholds its rate.
   */
  gateFor?: (decided: number) => PopulationVerdict;
}) {
  const { overall, lenders, undecided } = report;

  return (
    <Card span={span}>
      <CardHeader
        title="Lender outcomes"
        subtitle="One row per lender. Each rate is that lender's own offers over its own decisions."
        controls={
          report.from ? (
            <span className="text-[12px] tabular text-text-3">from {report.from}</span>
          ) : undefined
        }
      />

      {report.empty ? (
        <CardBody>
          <EmptyLine>No lender submissions have been ingested yet.</EmptyLine>
        </CardBody>
      ) : (
        <>
          <CardBody>
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
              <div>
                <p className="flex items-center gap-1.5 text-[13px] font-medium text-text-2">
                  Offer rate, all lenders
                  <InfoTip label="How the lender offer rate is measured" align="start">
                    Submissions a lender offered on, over the submissions a lender has decided —
                    offers plus declines. A submission nobody has answered is excluded, because a
                    lender that has not replied has not said no.
                  </InfoTip>
                </p>
                <p className="mt-1 text-[28px] font-semibold leading-[1.15] tabular text-text">
                  {overall.rate === null || (gateFor && !gateFor(overall.decided).sufficient) ? '—' : formatRate(overall.rate)}
                </p>
                <p className="mt-1 text-[13px] tabular text-text-2">
                  {formatCount(overall.offered)} of {formatCount(overall.decided)} decided
                </p>
              </div>

              <div>
                <p className="text-[13px] font-medium text-text-2">Excluded — no answer yet</p>
                <p className="mt-1 text-[28px] font-semibold leading-[1.15] tabular text-text-2">
                  {formatCount(overall.undecided)}
                </p>
                {/*
                  The reasons, broken out. Awaiting an answer is the pipeline
                  working; a submission that never completed is not, and one
                  carrying a status nobody has mapped is a gap on our side.
                  Three different facts, so three numbers rather than one word.
                */}
                <p className="mt-1 text-[13px] leading-snug text-text-2">
                  {undecided.length === 0
                    ? 'None'
                    : undecided
                        .map((u) => `${formatCount(u.count)} ${u.reason}`)
                        .join(' · ')}
                </p>
              </div>
            </div>
          </CardBody>

          <div className="overflow-x-auto">
            <table className="w-full min-w-0 border-collapse text-[13px]">
              <thead>
                <tr className="border-y border-border text-left text-text-2">
                  <th scope="col" className="px-5 py-2 font-medium">
                    Lender
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Offered
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Declined
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Offer rate
                  </th>
                  <th scope="col" className="px-5 py-2 text-right font-medium">
                    No answer yet
                  </th>
                </tr>
              </thead>
              <tbody>
                {lenders.map((lender) => (
                  <tr key={lender.lenderExternalId ?? lender.label} className="border-b border-border">
                    <th scope="row" className="px-5 py-2 text-left font-medium text-text">
                      {lender.label}
                    </th>
                    <td className="px-3 py-2 text-right tabular text-text">
                      {formatCount(lender.offers.offered)}
                    </td>
                    <td className="px-3 py-2 text-right tabular text-text">
                      {formatCount(lender.offers.declined)}
                    </td>
                    <td className="px-3 py-2 text-right tabular text-text">
                      {lender.offers.rate !== null && gateFor && !gateFor(lender.offers.decided).sufficient ? (
                        <span className="inline-flex items-center gap-1 text-text-3">
                          —
                          <InfoTip label="Why this lender's rate is withheld" align="end">
                            {gateFor(lender.offers.decided).reason}
                          </InfoTip>
                        </span>
                      ) : lender.offers.rate === null ? (
                        <span className="inline-flex items-center gap-1 text-text-3">
                          —
                          <InfoTip label="Why this lender has no rate" align="end">
                            This lender has not decided any submission in this window. A rate needs
                            a decision to divide by, and no answer is not a decline.
                          </InfoTip>
                        </span>
                      ) : (
                        formatRate(lender.offers.rate)
                      )}
                    </td>
                    <td className="px-5 py-2 text-right tabular text-text-2">
                      {formatCount(lender.offers.undecided)}
                    </td>
                  </tr>
                ))}
                {/*
                  A totals row that sums what is summable. Offers and declines
                  add across lenders; the rate is recomputed from those sums
                  rather than averaged, because an average of four lenders'
                  rates weights a lender with two decisions the same as one
                  with two hundred.
                */}
                <tr className="border-b border-border bg-canvas">
                  <th scope="row" className="px-5 py-2 text-left font-semibold text-text">
                    All lenders
                  </th>
                  <td className="px-3 py-2 text-right font-semibold tabular text-text">
                    {formatCount(overall.offered)}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular text-text">
                    {formatCount(overall.declined)}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular text-text">
                    {overall.rate === null || (gateFor && !gateFor(overall.decided).sufficient) ? '—' : formatRate(overall.rate)}
                  </td>
                  <td className="px-5 py-2 text-right font-semibold tabular text-text-2">
                    {formatCount(overall.undecided)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
            <Badge tone="neutral">Lender grain</Badge>
            <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
              One deal appears once per lender it was sent to, so these counts are submissions
              rather than deals and must not be compared with a funnel stage.
            </p>
          </div>
        </>
      )}
    </Card>
  );
}
