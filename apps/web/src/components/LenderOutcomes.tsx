import { formatCount, formatRangeLabel, formatRate, type PopulationVerdict } from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine } from '@/components/ui/Card';
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
 *   - **Undecided submissions are on the card, not in a caption**, split by
 *     where they stand (`pendingState` in core): waiting on a lender, no reply
 *     before the deal closed, and not completed. Only the first is anybody
 *     waiting, and the headline and the table's Waiting total are the same
 *     number. None of them is a soft no.
 *
 * Every figure is the picked period's, by submission date.
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
  const { overall, lenders, pending } = report;
  const submissionNoun = (n: number) => (n === 1 ? 'submission' : 'submissions');

  return (
    <Card span={span}>
      <CardHeader
        title="Lender outcomes"
        subtitle="One row per lender. Each rate is that lender's own offers over its own decisions."
        controls={<span className="text-[12px] tabular text-text-3">{formatRangeLabel(report.range)}</span>}
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
                  <InfoTip label="How the lender offer rate is worked out" align="start">
                    Offers divided by every offer or decline a lender has made. Applications still
                    waiting on a lender are left out, because no answer is not a no.
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
                <p className="flex items-center gap-1.5 text-[13px] font-medium text-text-2">
                  Waiting on a lender reply
                  <InfoTip label="What waiting on a lender reply counts" align="start">
                    Submissions a lender has not answered, on deals still open in Salesforce. A
                    submission on a deal already funded, declined or lost is not waiting on anybody.
                  </InfoTip>
                </p>
                <p className="mt-1 text-[28px] font-semibold leading-[1.15] tabular text-text">
                  {formatCount(pending.waiting)}
                </p>
                <p className="mt-1 text-[13px] leading-snug text-text-2">
                  {formatCount(pending.waiting)} {submissionNoun(pending.waiting)} on open deals
                </p>
              </div>

              <ul className="space-y-1 text-[13px] leading-snug text-text-2">
                <li>
                  <span className="font-semibold tabular text-text">{formatCount(pending.closed_unanswered)}</span>{' '}
                  got no reply before the deal closed
                </li>
                <li>
                  <span className="font-semibold tabular text-text">{formatCount(pending.not_completed)}</span>{' '}
                  {pending.not_completed === 1 ? 'was' : 'were'} not completed
                </li>
              </ul>
            </div>
          </CardBody>

          <div className="scroll-x min-w-0 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-[13px]">
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
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Waiting
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    No reply, deal closed
                  </th>
                  <th scope="col" className="px-5 py-2 text-right font-medium">
                    Not completed
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
                    <td className="px-3 py-2 text-right tabular text-text">
                      {formatCount(lender.pending.waiting)}
                    </td>
                    <td className="px-3 py-2 text-right tabular text-text-2">
                      {formatCount(lender.pending.closed_unanswered)}
                    </td>
                    <td className="px-5 py-2 text-right tabular text-text-2">
                      {formatCount(lender.pending.not_completed)}
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
                  <td className="px-3 py-2 text-right font-semibold tabular text-text">
                    {formatCount(pending.waiting)}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular text-text-2">
                    {formatCount(pending.closed_unanswered)}
                  </td>
                  <td className="px-5 py-2 text-right font-semibold tabular text-text-2">
                    {formatCount(pending.not_completed)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
            <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
              A deal sent to several lenders is counted once for each lender.
            </p>
          </div>
        </>
      )}
    </Card>
  );
}
