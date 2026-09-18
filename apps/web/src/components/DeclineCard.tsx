import { formatCount } from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { MiniChart, type MiniPoint } from '@/components/charts/MiniChart';
import type { DataQualityItem } from '@/lib/dashboard';

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
  /** The decline-reason dependency, still outstanding. */
  reason: DataQualityItem | null;
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

      {/*
        The one part that is genuinely not measured, kept as such — and with the
        real story rather than "sparse". A field that was filled in perfectly and
        then abandoned is a process change to raise with the client, not a gap to
        design around.
      */}
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
    </Card>
  );
}
