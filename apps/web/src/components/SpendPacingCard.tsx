import {
  formatCount,
  formatCurrency,
  formatRate,
  pacingState,
  type BudgetPacing,
} from '@zeeraa/core';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { Progress } from '@/components/ui/Progress';
import { MiniChart, type MiniPoint } from '@/components/charts/MiniChart';

const STATE: Record<string, { label: string; tone: 'neutral' | 'warn' }> = {
  on_plan: { label: 'On plan', tone: 'neutral' },
  over: { label: 'Ahead of plan', tone: 'warn' },
  under: { label: 'Behind plan', tone: 'warn' },
};

/**
 * Paid media spend this month, against what the month contracts.
 *
 * Two figures and a bar. The spend is a measurement; the pacing is the thing a
 * reader actually wants and the thing nobody computes correctly in their head
 * halfway through a month.
 *
 * **No colour judgement on the state.** Spending faster than the month is
 * passing is not a failure and spending slower is not thrift — what the spend
 * bought decides that, and cost per stage is the metric that answers it. So the
 * badge is amber for "not on plan" in either direction, which reads as "look at
 * this", and never green for "on plan", which would read as a score.
 *
 * Where no budget is recorded the card still renders the spend, with the
 * dependency stated. A briefing that hid the spend because the budget was
 * missing would lose the measurement to protect the comparison.
 */
export function SpendPacingCard({
  spent,
  pacing,
  currency,
  periodLabel,
  points,
  /** Why there is no budget, when there is none. */
  budgetMissing,
  elapsedDays,
  monthDays,
  span = 6,
}: {
  spent: number;
  /** Null where no budget is recorded for this month. */
  pacing: BudgetPacing | null;
  currency: string;
  periodLabel: string;
  points: MiniPoint[];
  budgetMissing: string;
  elapsedDays: number;
  monthDays: number;
  span?: 4 | 6 | 8;
}) {
  const state = pacing ? pacingState(pacing) : null;

  return (
    <Card span={span} className="justify-between">
      <CardHeader
        title="Paid media spend"
        subtitle={periodLabel}
        controls={
          /*
            `No budget set`, not `Not measured`. The spend is measured — it is
            the large number on the card — and only the comparison is missing.
            The amber badge every other card uses would say the opposite of what
            this one is showing.
          */
          pacing ? (
            <Badge tone={STATE[state!]!.tone}>{STATE[state!]!.label}</Badge>
          ) : (
            <Badge tone="warn">No budget set</Badge>
          )
        }
        info={
          <InfoTip label="How pacing is measured" align="start">
            Spend so far this month divided by the share of the month elapsed,
            which is where the month lands at this rate. No direction is declared
            for spend: what it bought is what decides whether it was well spent.
          </InfoTip>
        }
      />

      <CardBody className="flex-1 pb-0">
        <p className="text-[28px] font-semibold leading-[1.15] tabular text-text">
          {formatCurrency(spent, currency)}
        </p>

        {!pacing ? (
          <p className="mt-1 text-[13px] leading-snug text-text-3">{budgetMissing}</p>
        ) : (
          <>
            <p className="mt-1 text-[13px] tabular text-text-2">
              of {formatCurrency(pacing.budget, currency)} contracted ·{' '}
              {formatRate(pacing.spentShare)} spent
            </p>

            <div className="mt-2.5">
              <Progress
                value={pacing.spentShare}
                tone={state === 'on_plan' ? 'primary' : 'warn'}
                label={`${formatRate(pacing.spentShare)} of the month's budget spent, with ${formatRate(
                  pacing.elapsed,
                )} of the month elapsed`}
              />
              <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[12px] tabular text-text-3">
                <span>
                  day {formatCount(elapsedDays)} of {formatCount(monthDays)} ·{' '}
                  {formatRate(pacing.elapsed)} elapsed
                </span>
                {/* The projection, with its own stability stated. Two days into
                    a month one heavy day doubles it, and a figure that is
                    correct and volatile is exactly the one a client quotes back
                    a fortnight later. */}
                {pacing.projected !== null && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      {pacing.confident ? 'lands at' : 'early estimate'}{' '}
                      <span className="font-medium text-text-2">
                        {formatCurrency(pacing.projected, currency)}
                      </span>
                    </span>
                    <InfoTip label="How the projection is made" align="end">
                      Spend so far divided by the share of the month elapsed.
                      {pacing.confident
                        ? ' Past a quarter of the month this is stable enough to plan against.'
                        : ' Less than a quarter of the month has passed, so one heavy day still moves this a long way.'}
                    </InfoTip>
                  </>
                )}
              </p>
            </div>
          </>
        )}
      </CardBody>

      <div className="mt-3 px-1 pb-1">
        <MiniChart points={points} variant="area" label="Paid media spend by month" height={56} />
      </div>
    </Card>
  );
}
