import { formatCount, formatCurrency, type ChannelCostPerDeal } from '@zeeraa/core';

/**
 * A cost-per-deal figure, with its coverage and its range.
 *
 * There is no prop here that takes a number. The component accepts a
 * `ChannelCostPerDeal` and nothing else, which is what makes the rule
 * enforceable rather than reviewable: a developer cannot render a bare figure by
 * forgetting to pass the context, because the context is the argument.
 *
 * The three parts are one metric, not a figure with notes attached:
 *
 *   - the value, over the deals attributed to this channel;
 *   - the coverage, which says what it could not speak for;
 *   - the range, which says how far the deals it could not speak for could move
 *     it.
 *
 * A number whose limits are not visible is read as a number that has none. That
 * is the same principle as `Sourced<T>` one level up, and the reason a figure
 * here never renders alone.
 */

function Range({ cost, currency }: { cost: ChannelCostPerDeal; currency: string }) {
  const { low, high } = cost.plausibleRange;
  if (cost.unattributedDeals === 0 || low === null || high === null) return null;
  return (
    <>
      {formatCurrency(low, currency)} – {formatCurrency(high, currency)}
    </>
  );
}

/**
 * The large form, for the executive band. Dark ground, so brass is legible.
 */
export function CostPerDealDisplay({
  cost,
  currency,
  label,
  channelLabel,
  target,
}: {
  cost: ChannelCostPerDeal;
  currency: string;
  label: string;
  /** Which channel this is. Named on the figure, never implied. */
  channelLabel: string;
  target?: { value: number; label: string } | null;
}) {
  if (cost.value === null) {
    return (
      <div>
        <p className="text-[12px] text-paper/60">
          {label} · {channelLabel}
        </p>
        <p className="mt-3 font-display text-[44px] leading-none text-paper/35 sm:text-[56px]">
          Not yet measurable
        </p>
        <p className="mt-4 max-w-prose text-[12px] leading-relaxed text-paper/70">
          {formatCurrency(cost.channelSpend, currency)} of {channelLabel} spend in this period, and
          no funded deal the platform can attribute to it. A cost per deal with nothing in the
          denominator is not zero and not infinite — it is absent, and is shown as absent.
          {cost.unattributedDeals > 0 && (
            <>
              {' '}
              {formatCount(cost.unattributedDeals)} funded{' '}
              {cost.unattributedDeals === 1 ? 'deal' : 'deals'} in this period carry no click from
              any connected channel.
            </>
          )}
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-[12px] text-paper/60">
        {label} · {channelLabel}
      </p>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <p className="figure-display text-[44px] leading-none text-paper sm:text-[56px]">
          {formatCurrency(cost.value, currency)}
        </p>
        {target && (
          <p className="text-[13px] text-brass-bright tabular-nums">
            Target {formatCurrency(target.value, currency)}
            <span className="text-paper/50"> · {target.label}</span>
          </p>
        )}
      </div>

      {/* Coverage. Part of the figure, on the same ground, above the fold. */}
      <p className="mt-4 text-[12px] leading-relaxed text-paper/70 tabular-nums">
        Over {formatCount(cost.attributedDeals)}{' '}
        {cost.attributedDeals === 1 ? 'deal' : 'deals'} attributed to {channelLabel}, from{' '}
        {formatCurrency(cost.channelSpend, currency)} of {channelLabel} spend.
        {cost.unattributedDeals > 0 && (
          <>
            {' '}
            A further {formatCount(cost.unattributedDeals)} funded{' '}
            {cost.unattributedDeals === 1 ? 'deal' : 'deals'} in this period carry no click from any
            connected channel and are not in this denominator.
          </>
        )}
        {cost.dealsAttributedElsewhere > 0 && (
          <>
            {' '}
            {formatCount(cost.dealsAttributedElsewhere)} are attributed to another channel.
          </>
        )}
      </p>

      {cost.unattributedDeals > 0 && (
        <p className="mt-2 text-[12px] leading-relaxed text-paper/70 tabular-nums">
          <span className="text-paper">
            <Range cost={cost} currency={currency} />
          </span>{' '}
          if every unattributed deal turned out to be {channelLabel}, through none of them. The
          figure above is the upper end — what the data confirms.
        </p>
      )}
    </div>
  );
}

/**
 * The table-cell form.
 *
 * Still carries coverage and range: a column of bare figures in a table is
 * exactly where a reader starts comparing channels whose coverage differs by a
 * factor of three.
 */
export function CostPerDealCell({
  cost,
  currency,
}: {
  cost: ChannelCostPerDeal;
  currency: string;
}) {
  if (cost.value === null) {
    return (
      <td className="numeric px-3 py-2.5 align-top">
        <span className="text-provisional" title="No deal in this period is attributed to this channel.">
          —
        </span>
        <span className="mt-0.5 block text-[11px] text-graphite">no attributed deal</span>
      </td>
    );
  }

  return (
    <td className="numeric px-3 py-2.5 align-top">
      <span className="text-ink">{formatCurrency(cost.value, currency)}</span>
      <span className="mt-0.5 block text-[11px] text-graphite">
        over {formatCount(cost.attributedDeals)}
      </span>
      {cost.unattributedDeals > 0 && (
        <span className="mt-0.5 block text-[11px] text-graphite">
          <Range cost={cost} currency={currency} />
        </span>
      )}
    </td>
  );
}

/**
 * The cell used where a cost per deal deliberately does not exist — the
 * unattributed row and the totals row.
 *
 * A separate component rather than a prop on the one above, so that "this
 * channel has no attributed deal yet" and "this question does not apply to this
 * row" cannot be rendered by the same code path and end up looking the same.
 */
export function NoCostPerDealCell({ reason }: { reason: string }) {
  return (
    <td className="numeric px-3 py-2.5 align-top">
      <span className="text-provisional" title={reason}>
        —
      </span>
      <span className="mt-0.5 block text-[11px] text-graphite">not applicable</span>
    </td>
  );
}
