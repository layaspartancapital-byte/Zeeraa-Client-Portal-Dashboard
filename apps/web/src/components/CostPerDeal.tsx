import {
  formatCount,
  formatCurrency,
  type ChannelCostPerDeal,
} from '@zeeraa/core';
import { InfoTip } from '@/components/ui/InfoTip';

/**
 * What a cost per deal was divided by, in the client's words:
 * `Based on 3 deals`.
 *
 * Every cost per deal carries it, at any size — the minimum-deal rule no
 * longer applies to costs (see `packages/core/src/population.ts`), so this
 * line is how a reader tells a figure over two deals from one over twenty.
 * The plausible range it used to add was analyst detail and is gone.
 */
export function coverageLine(cost: ChannelCostPerDeal, _currency?: string): string {
  const n = cost.attributedDeals;
  return `Based on ${formatCount(n)} ${n === 1 ? 'deal' : 'deals'}`;
}

/** The one-sentence ⓘ behind a cost per deal. */
export function coverageExplanation(
  cost: ChannelCostPerDeal,
  currency: string,
  channelLabel: string,
): string {
  const n = cost.attributedDeals;
  return (
    `${formatCurrency(cost.channelSpend, currency)} of ${channelLabel} spend divided by the ` +
    `${formatCount(n)} funded ${n === 1 ? 'deal' : 'deals'} that came from ${channelLabel}.`
  );
}

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
      <InfoTip label="How this cost per deal is worked out" align="start">
        {coverageExplanation(cost, currency, channelLabel)}
      </InfoTip>
    </p>
  );
}

/**
 * A cost per deal: the number, and what it was based on beneath it. There is
 * no prop that accepts a bare number, so the line cannot be forgotten.
 *
 * Only an empty denominator has no figure, and it says "No deals yet" — an
 * empty denominator is not zero and not infinite.
 */
export function CostPerDealFigure({
  cost,
  currency,
  channelLabel,
  size = 'kpi',
  className = '',
}: {
  cost: ChannelCostPerDeal;
  currency: string;
  channelLabel: string;
  size?: 'kpi' | 'hero';
  className?: string;
}) {
  const figure = size === 'hero' ? 'text-[40px] sm:text-[44px]' : 'text-[28px]';

  if (cost.value === null || cost.attributedDeals === 0) {
    return (
      <div className={className}>
        <p className="py-1.5 text-[15px] font-medium text-text-3">No deals yet</p>
        <p className="mt-1 text-[13px] tabular text-text-2">
          {formatCurrency(cost.channelSpend, currency)} of {channelLabel} spend so far
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <p className={`font-semibold leading-[1.1] tabular text-text ${figure}`}>
        {formatCurrency(cost.value, currency)}
      </p>
      <CostPerDealCoverage cost={cost} currency={currency} channelLabel={channelLabel} className="mt-1" />
    </div>
  );
}
