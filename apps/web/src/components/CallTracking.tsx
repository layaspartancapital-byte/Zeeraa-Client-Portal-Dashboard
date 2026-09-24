import { formatCount, formatDuration, formatRate } from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { Progress } from '@/components/ui/Progress';
import { MonthBars } from '@/components/charts/MonthBars';
import { monthBars } from '@/lib/month-bars';
import type { CallReport } from '@/lib/reporting';

/**
 * Call tracking, from Aloware.
 *
 * Four figures, and the order is the argument: coverage first, because
 * everything after it is computed over the matched subset and means nothing
 * without it.
 *
 * Three rules this card exists to keep:
 *
 *   * **Connected, attempted and abandoned never share a total.** Abandoned is
 *     the caller hanging up before anybody answered — neither a conversation
 *     nor an attempt at one — so it is outside the connect rate's denominator
 *     entirely.
 *   * **The connected threshold is on screen.** The vendor marks nearly every
 *     call `completed`, and most of those talked for seconds. A connect rate
 *     is only as meaningful as the rule that produced it, and that rule is a
 *     config row, so it is rendered rather than documented elsewhere.
 *   * **Speed to lead carries the leads it could not measure.** A median over
 *     the called leads is not a median over the leads.
 *
 * No phone number, contact name or agent name appears here. The card renders
 * counts, shares and durations; the underlying rows hold PII and none of it is
 * needed to answer the question.
 */
export function CallTracking({
  report,
  span,
  today,
}: {
  report: CallReport;
  span?: 4 | 6 | 8 | 12;
  /** The tenant's today, so the month in progress is marked partial. */
  today: string;
}) {
  const { volume, match, speed, speedAllHours, attempts } = report;

  if (report.empty) {
    return (
      <Card span={span}>
        <CardHeader title="Call tracking" subtitle="Aloware" />
        <CardBody>
          <EmptyLine>No calls have been imported yet.</EmptyLine>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card span={span}>
      <CardHeader
        title="Call tracking"
        subtitle="Aloware, joined to leads by phone number"
        controls={
          report.from ? (
            <span className="text-[12px] tabular text-text-3">from {report.from}</span>
          ) : undefined
        }
      />

      <CardBody>
        {/* Coverage first: every figure below is over the matched subset. */}
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <div className="min-w-[200px]">
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-text-2">
              Calls matched to a lead
              <InfoTip label="How calls are matched to leads" align="start">
                By phone number, normalised to ten digits on both sides. A number held by more than
                one lead is left unmatched rather than assigned to the newest — nothing says which
                lead the call belongs to, and guessing would make speed to lead look measured when
                it is arbitrary.
              </InfoTip>
            </p>
            <p className="mt-1 text-[28px] font-semibold leading-[1.15] tabular text-text">
              {match.coverage === null ? '—' : formatRate(match.coverage)}
            </p>
            <p className="mt-1 text-[13px] tabular text-text-2">
              {formatCount(match.matched)} of {formatCount(match.total)} calls
            </p>
            <Progress
              value={match.coverage ?? 0}
              label="Share of calls carrying a lead"
              className="mt-2"
            />
            <p className="mt-1.5 text-[12px] leading-snug text-text-3">
              {formatCount(match.unmatchedNoLead)} matched no lead in the CRM ·{' '}
              {formatCount(match.unkeyable)} had no usable number
            </p>
          </div>

          <div className="min-w-[190px]">
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-text-2">
              Connected
              <InfoTip label="What counts as connected" align="start">
                A completed call that talked for at least{' '}
                {formatDuration(report.connectedMinTalkSeconds)}. The dialer marks almost every
                call completed regardless of whether anybody spoke, so the threshold is what
                separates a conversation from an answering machine —{' '}
                {formatCount(report.answeredBriefly)} calls in this window were answered and over
                inside it.
              </InfoTip>
            </p>
            <p className="mt-1 text-[28px] font-semibold leading-[1.15] tabular text-text">
              {formatCount(volume.connected)}
            </p>
            <p className="mt-1 text-[13px] tabular text-text-2">
              {volume.connectRate === null
                ? 'nothing handled'
                : `${formatRate(volume.connectRate)} of ${formatCount(volume.handled)} handled`}
            </p>
            <p className="mt-1.5 text-[12px] leading-snug text-text-3">
              talk time ≥ {formatDuration(report.connectedMinTalkSeconds)}
            </p>
          </div>

          <div className="min-w-[170px]">
            <p className="text-[13px] font-medium text-text-2">Attempted</p>
            <p className="mt-1 text-[28px] font-semibold leading-[1.15] tabular text-text">
              {formatCount(volume.attempted)}
            </p>
            <p className="mt-1 text-[13px] tabular text-text-2">
              {formatCount(report.answeredBriefly)} answered, under the threshold
            </p>
          </div>

          <div className="min-w-[170px]">
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-text-2">
              Abandoned
              <InfoTip label="Why abandoned is counted apart" align="start">
                The caller ended the call before anybody answered. Neither a conversation nor an
                attempt at one, so it is in neither of the other two counts and outside the connect
                rate's denominator — the desk cannot connect a call that was hung up.
              </InfoTip>
            </p>
            <p className="mt-1 text-[28px] font-semibold leading-[1.15] tabular text-text-2">
              {formatCount(volume.abandoned)}
            </p>
            <p className="mt-1 text-[13px] tabular text-text-2">excluded from both</p>
          </div>

          <div className="min-w-[260px] flex-1">
            <p className="text-[13px] font-medium text-text-2">Calls per month</p>
            <MonthBars
              id="calls-per-month"
              noun={['call', 'calls']}
              height={170}
              bars={monthBars(
                report.monthly.map((m) => ({ month: m.month, value: m.connected + m.attempted })),
                { firstDay: report.from, today },
              )}
            />
          </div>
        </div>
      </CardBody>

      {/* Speed to lead and attempts: both over leads, not over calls. */}
      <div className="border-t border-border px-5 py-4">
        <div className="flex flex-wrap items-start gap-x-10 gap-y-4">
          <div className="min-w-[230px]">
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-text">
              Speed to lead
              <InfoTip label="How speed to lead is measured" align="start">
                From the lead being created in the CRM to the first outbound call to that lead's
                number
                {report.businessHours
                  ? ", counting only the desk's hours: a lead that arrives after closing starts its clock at the next opening, and one rung before the opening is a zero wait."
                  : ', on the wall clock, nights and weekends included.'}{' '}
                Inbound calls, and calls stamped before their lead, are excluded. The median, not
                the mean: one lead called three weeks late moves a mean and tells you nothing about
                the desk.
              </InfoTip>
            </p>
            <p className="mt-1 text-[24px] font-semibold leading-tight tabular text-text">
              {formatDuration(speed.medianSeconds)}
            </p>
            <p className="mt-1 text-[13px] tabular text-text-2">
              median · p90 {formatDuration(speed.p90Seconds)}
            </p>
            {/*
              The clock is part of the figure. Nine minutes on business hours
              and nine minutes on the wall clock are different claims, and the
              24/7 median stays beside it so the change of clock is visible on
              the card rather than only in the history.
            */}
            <p className="mt-1.5 text-[12px] leading-snug text-text-3">{report.clock}</p>
            {report.businessHours && (
              <p className="mt-0.5 text-[12px] leading-snug tabular text-text-3">
                24/7 median {formatDuration(speedAllHours.medianSeconds)}
              </p>
            )}
            {/*
              The population, on the figure. A median over the called leads is
              not a median over the leads, and the difference here is most of
              them.
            */}
            <p className="mt-1.5 text-[12px] leading-snug text-text-3">
              over {formatCount(speed.called)} leads called of{' '}
              {formatCount(speed.called + speed.notCalled)} created
              {speed.coverage === null ? '' : ` · ${formatRate(speed.coverage)}`}
            </p>
          </div>

          <div className="min-w-[200px]">
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-text">
              Called within five minutes
              <InfoTip label="What this share is over" align="start">
                Of the leads that were called at all, not of every lead — the leads nobody called
                have no response time to be inside or outside five minutes. On the same clock as
                speed to lead.
              </InfoTip>
            </p>
            <p className="mt-1 text-[24px] font-semibold leading-tight tabular text-text">
              {speed.withinFiveMinutesShare === null
                ? '—'
                : formatRate(speed.withinFiveMinutesShare)}
            </p>
            <p className="mt-1 text-[13px] tabular text-text-2">
              {formatCount(speed.withinFiveMinutes)} of {formatCount(speed.called)} called
            </p>
            <p className="mt-1.5 text-[12px] leading-snug text-text-3">{report.clock}</p>
          </div>

          <div className="min-w-[210px]">
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-text">
              Attempts per lead
              <InfoTip label="What counts as an attempt" align="start">
                Outbound calls to a lead, abandoned excluded — an abandoned call is not an attempt
                the desk made. Over the leads that were called: dividing by every lead would
                measure how many leads the desk works, not how hard it works them.
              </InfoTip>
            </p>
            <p className="mt-1 text-[24px] font-semibold leading-tight tabular text-text">
              {attempts.mean === null ? '—' : attempts.mean.toFixed(1)}
            </p>
            <p className="mt-1 text-[13px] tabular text-text-2">
              mean · median {attempts.median === null ? '—' : formatCount(attempts.median)} ·{' '}
              {formatCount(attempts.attempts)} attempts over{' '}
              {formatCount(attempts.leadsCalled)} leads
            </p>
            <p className="mt-1.5 text-[12px] leading-snug text-text-3">
              {formatCount(attempts.connectedFirstAttempt)} reached on the first attempt ·{' '}
              {formatCount(attempts.chasedNeverConnected)} called more than once and never reached
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
        <Badge tone="neutral">Call grain</Badge>
        <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
          Read from Aloware directly, not from the Aloware records in Salesforce: that copy's
          completeness depends on the vendor's own CRM integration, and a gap in it would look like
          a quiet day on the phones.
        </p>
      </div>
    </Card>
  );
}
