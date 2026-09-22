import { formatCount, formatRate } from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { MiniChart, type MiniPoint } from '@/components/charts/MiniChart';
import type { DataQualityItem } from '@/lib/dashboard';
import type { SubmissionReport } from '@/lib/reporting';

/**
 * Declines: how many and when, separately from why.
 *
 * Those are three different questions and only one of them is unanswerable.
 * `Loss_Reason__c` was filled in on every closed-lost opportunity through
 * January 2025 and then abandoned, so the *reason* is not recoverable — but
 * `csbs__Declined_Date_Time__c` is populated on 89% of closed-lost deals and
 * the `StageName` history carries the transitions besides, so volume and timing
 * are well measured.
 *
 * Presenting all three as one blocked dependency, which is what the screen used
 * to do, threw away two answers to protect one. A client asking "how many deals
 * are we losing" was told the platform could not say, when it could.
 */
export function DeclineCard({
  points,
  total,
  events,
  range,
  reason,
  submissions = null,
  span,
}: {
  /** Declines per month, for the timing. */
  points: MiniPoint[];
  /** Distinct opportunities declining in the window. */
  total: number;
  /**
   * Transitions into Declined in the same window.
   *
   * Above `total` when a deal was declined, revived and declined again. Shown
   * rather than reconciled away: it is the difference between how many deals
   * were lost and how many times underwriting said no, and a reader comparing
   * this card to a CRM report will hit it.
   */
  events: number;
  /** The window itself, because a volume without its period is not a figure. */
  range: { start: string; end: string };
  /**
   * The decline-reason dependency, where one is still outstanding.
   *
   * Kept for the deal-level field: `Loss_Reason__c` is abandoned and no lender
   * data brings it back. Rendered only when `submissions` has nothing to say.
   */
  reason: DataQualityItem | null;
  /**
   * Lender declines, which is where the reasons actually live.
   *
   * A different grain from the deal count above it, and labelled as one: a
   * deal declined by three lenders is one decline up there and three down
   * here. They are in one card because they answer one question, and separated
   * by a rule and a grain badge because a reader given two numbers on one line
   * will divide them.
   */
  submissions?: SubmissionReport | null;
  /**
   * Omitted when the card sits inside a column of its own, which is how the
   * funnel places it — a span there would nest a grid span inside a flex
   * column and silently do nothing.
   */
  span?: 4 | 6 | 8 | 12;
}) {
  return (
    <Card span={span}>
      <CardHeader
        title="Declines"
        subtitle="How many, and when. Why is a separate question."
      />

      <CardBody className="flex-1">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div>
            <p className="text-[13px] font-medium text-text-2">Deals declined in this window</p>
            <p className="mt-1 text-[28px] font-semibold leading-[1.15] tabular text-text">
              {formatCount(total)}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-text-2 tabular">
              {range.start} to {range.end}
              {/*
                Deliberately not "x% of applications". Declines in a window
                include deals that applied before it, so dividing the two
                window counts compares different cohorts — it read 124.7%,
                which is the arithmetic saying so. A real decline rate follows
                one cohort forward and is a different query.
              */}
              <InfoTip label="What this counts, and why there is no rate" align="start">
                Distinct deals, from {formatCount(events)} transitions into Declined — a deal
                declined, revived and declined again is one deal here and two transitions.
                Measured from csbs__Declined_Date_Time__c and the StageName transitions, which
                between them cover 89% of closed-lost deals. A volume, not a rate: deals
                declining in this window include ones that applied before it, so dividing by
                applications in the same window compares two different cohorts — it came out at
                124.7%.
              </InfoTip>
            </p>
          </div>

          <div className="min-w-[180px] flex-1">
            <p className="text-[13px] font-medium text-text-2">Declines per month</p>
            <MiniChart points={points} variant="bars" label="Declines per month" height={64} />
          </div>
        </div>
      </CardBody>

      {submissions && submissions.citations.reasons.length > 0 ? (
        <ReasonsMeasured report={submissions} />
      ) : (
        /*
          The deal-level field, kept as not measured — and with the real story
          rather than "sparse". A field that was filled in perfectly and then
          abandoned is a process change to raise with the client, not a gap to
          design around.
        */
        <div className="border-t border-border px-5 py-3">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-1.5">
                <span className="text-[13px] font-medium text-text">Decline reasons</span>
                {reason && (
                  <InfoTip label="Why decline reasons are not measured" align="start">
                    {reason.detail || reason.summary}
                  </InfoTip>
                )}
              </p>
              {reason ? (
                <p className="mt-0.5 text-[13px] leading-snug text-text-2">{reason.summary}</p>
              ) : (
                <EmptyLine className="mt-0.5">No reason dependency is recorded.</EmptyLine>
              )}
            </div>
            <Badge tone="warn">Not measured</Badge>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * Why lenders declined, with coverage per month and never one figure across
 * them.
 *
 * `Decline_Reason__c` is being adopted, not used: 0% of declines in June,
 * 15.4% in July, 9.1% in August, 30.5% in September. An all-time 20.5% would
 * average an unused field with an adopted one and describe neither month, so
 * there is no all-time number here — the months are listed, and the ⓘ carries
 * the trend.
 *
 * The citations are a count, not a share. The source is a multipicklist, so one
 * lender can cite three reasons for one decline and the citations sum above the
 * declines; rendering a percentage would invite a reader to add them to 100.
 */
function ReasonsMeasured({ report }: { report: SubmissionReport }) {
  const { citations, reasonCoverage } = report;
  const recent = [...reasonCoverage].reverse().find((m) => m.declined > 0) ?? null;
  const top = citations.reasons.slice(0, 5);
  const most = top[0]?.citations ?? 1;

  return (
    <div className="border-t border-border px-5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-medium text-text">Why lenders declined</span>
            <InfoTip label="How decline reasons are measured" align="start">
              Reasons a lender gave on its own submission, so a deal declined by three lenders
              contributes three. The field is a multipicklist and one decline can cite several
              reasons, so these are citations rather than shares and do not sum to the declines.
              Coverage is rising as the field is adopted:{' '}
              {reasonCoverage
                .filter((m) => m.declined > 0)
                .map((m) => `${m.period} ${m.share === null ? '—' : formatRate(m.share)}`)
                .join(', ')}
              .
            </InfoTip>
          </p>
          <p className="mt-0.5 text-[13px] tabular text-text-2">
            {formatCount(citations.total)} citations from{' '}
            {formatCount(citations.declinesWithReason)} lender declines
            {recent
              ? ` · ${recent.period} coverage ${
                  recent.share === null ? '—' : formatRate(recent.share)
                }`
              : ''}
          </p>
        </div>
        <Badge tone="neutral">Lender grain</Badge>
      </div>

      <ul className="mt-2 space-y-1.5">
        {top.map((row) => (
          <li key={row.reason} className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-[13px] text-text">{row.reason}</span>
            {/*
              A bar scaled to the most-cited reason, not to the decline count.
              Scaling to declines would draw every reason as a sliver of a whole
              that these citations are not a partition of.
            */}
            <span
              aria-hidden="true"
              className="h-1.5 w-[84px] shrink-0 overflow-hidden rounded-[2px] bg-canvas"
            >
              <span
                className="block h-full rounded-[2px] bg-plot"
                style={{ width: `${Math.max(6, (row.citations / most) * 100)}%` }}
              />
            </span>
            <span className="w-8 shrink-0 text-right text-[13px] tabular text-text-2">
              {formatCount(row.citations)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
