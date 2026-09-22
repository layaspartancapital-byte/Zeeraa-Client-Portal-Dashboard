import {
  formatCount,
  formatCurrency,
  type ChannelCostPerDeal,
  type PopulationVerdict,
} from '@zeeraa/core';
import { NotMeasuredBadge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';

/**
 * A cost-per-deal figure, with its coverage and its range.
 *
 * There is no prop here that takes a number. The component accepts a
 * `ChannelCostPerDeal` and nothing else, which is what makes the rule
 * enforceable rather than reviewable: a developer cannot render a bare figure
 * by forgetting to pass the context, because the context is the argument.
 *
 * Spec v2 changed the shape of that context, not its presence. It used to be
 * two paragraphs under the number; it is now one small line —
 * `Over 9 attributed deals · range $3,768–$8,793` — with the full explanation
 * behind the ⓘ beside it.
 */

export function coverageLine(cost: ChannelCostPerDeal, currency: string): string {
  const parts = [
    `Over ${formatCount(cost.attributedDeals)} attributed ${
      cost.attributedDeals === 1 ? 'deal' : 'deals'
    }`,
  ];
  const { low, high } = cost.plausibleRange;
  if (cost.unattributedDeals > 0 && low !== null && high !== null) {
    parts.push(`range ${formatCurrency(low, currency)}–${formatCurrency(high, currency)}`);
  }
  return parts.join(' · ');
}

/**
 * The explanation the ⓘ carries. Two sentences, which is the budget spec v2 §2
 * sets for a tooltip.
 */
export function coverageExplanation(
  cost: ChannelCostPerDeal,
  currency: string,
  channelLabel: string,
): string {
  const base =
    `${formatCurrency(cost.channelSpend, currency)} of ${channelLabel} spend over the ` +
    `${formatCount(cost.attributedDeals)} funded ${
      cost.attributedDeals === 1 ? 'deal' : 'deals'
    } attributed to ${channelLabel} — the only denominator this metric has.`;

  if (cost.unattributedDeals === 0) return base;

  return (
    `${base} A further ${formatCount(cost.unattributedDeals)} funded ${
      cost.unattributedDeals === 1 ? 'deal carries' : 'deals carry'
    } no click from any connected channel and ` +
    `${cost.unattributedDeals === 1 ? 'is' : 'are'} not in it; the range is where the ` +
    `figure would land if every one of them turned out to be ${channelLabel}.`
  );
}

/**
 * The coverage line on its own, for a figure rendered by a KPI or hero card.
 * `CostPerDealFigure` below composes it with the value.
 */
export function CostPerDealCoverage({
  cost,
  currency,
  channelLabel,
  className = '',
}: {
  cost: ChannelCostPerDeal;
  currency: string;
  channelLabel: string;
  className?: string;
}) {
  return (
    <p className={`flex flex-wrap items-center gap-1.5 text-[13px] text-text-2 tabular ${className}`}>
      {coverageLine(cost, currency)}
      <InfoTip label="How this cost per deal is measured" align="start">
        {coverageExplanation(cost, currency, channelLabel)}
      </InfoTip>
    </p>
  );
}

/**
 * The figure, its coverage and its range, as one metric.
 *
 * Renders an explicit absence where nothing is attributed: a cost per deal with
 * an empty denominator is not zero and not infinite, and a dash with a reason
 * is the only honest mark for it.
 */
export function CostPerDealFigure({
  cost,
  currency,
  channelLabel,
  gate,
  size = 'kpi',
  className = '',
}: {
  cost: ChannelCostPerDeal;
  currency: string;
  channelLabel: string;
  /**
   * Whether the denominator is large enough for the figure to mean anything.
   *
   * Optional, and absent means ungated — but where it is supplied and fails,
   * the figure does not render at all. A cost per deal over two deals moves by
   * half when one more lands, and it is the number a client repeats in a
   * meeting; it is not improved by being rendered smaller or with a caveat
   * beside it.
   */
  gate?: PopulationVerdict;
  size?: 'kpi' | 'hero';
  className?: string;
}) {
  const figure = size === 'hero' ? 'text-[40px] sm:text-[44px]' : 'text-[28px]';

  if (cost.value !== null && gate && !gate.sufficient) {
    return (
      <div className={className}>
        <NotMeasuredBadge />
        <p className="mt-2 text-[13px] leading-snug text-text-3">
          {gate.reason} Over a short range this figure measures the sample rather than{' '}
          {channelLabel}.
        </p>
        <p className="mt-1 text-[13px] tabular text-text-2">
          {formatCurrency(cost.channelSpend, currency)} spent ·{' '}
          {formatCount(cost.attributedDeals)} attributed{' '}
          {cost.attributedDeals === 1 ? 'deal' : 'deals'}
        </p>
      </div>
    );
  }

  if (cost.value === null) {
    return (
      <div className={className}>
        <p className={`font-semibold leading-[1.1] text-text-3 ${figure}`}>&mdash;</p>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-text-2">
          No funded deal in this window is attributed to {channelLabel}
          <InfoTip label="Why there is no cost per deal" align="start">
            {formatCurrency(cost.channelSpend, currency)} of {channelLabel} spend and no deal the
            platform can attribute to it. A cost per deal with nothing in the denominator is
            absent, not zero.
          </InfoTip>
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <p className={`font-semibold leading-[1.1] tabular text-text ${figure}`}>
        {formatCurrency(cost.value, currency)}
      </p>
      <CostPerDealCoverage
        cost={cost}
        currency={currency}
        channelLabel={channelLabel}
        className="mt-1"
      />
    </div>
  );
}
