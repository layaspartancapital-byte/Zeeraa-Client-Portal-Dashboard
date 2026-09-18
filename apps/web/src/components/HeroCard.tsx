import type { ReactNode } from 'react';
import type { ChannelCostPerDeal, ImprovementDirection } from '@zeeraa/core';
import { Card, CardHeader } from '@/components/ui/Card';
import { Delta, NoDelta } from '@/components/ui/Delta';
import { InfoTip } from '@/components/ui/InfoTip';
import { ProvisionalBadge } from '@/components/ui/Badge';
import { CostPerDealFigure } from '@/components/CostPerDeal';
import { AreaSeries, type SeriesPoint } from '@/components/charts/AreaSeries';

export type SecondaryFigure = {
  label: string;
  /** Formatted, or null where the period has no measurement. */
  value: string | null;
  current: number | null;
  baseline: number | null;
};

/**
 * The executive hero (spec v2 §6).
 *
 * Eight columns: the north-star figure at 40–44px with its coverage, a row of
 * period figures across the top of the plot area, and the metric over time as a
 * gradient-filled area chart with the target dashed at the right edge.
 *
 * What it renders is one *channel's* cost per funded deal, named as one
 * channel's. A blended figure across every channel has a different denominator
 * — total marketing spend over total marketing-sourced deals — and is not
 * computable until every channel is ingested. Showing the one live channel's
 * number under a blended label would be the most expensive kind of quiet error:
 * right arithmetic, wrong noun, on the screen the client repeats internally.
 * The ⓘ on the title says so; nothing about it is inline any more.
 */
export function HeroCard({
  metricLabel,
  channelLabel,
  cost,
  previousCost,
  currency,
  direction,
  points,
  target,
  secondary,
  periodToggle,
  provisional,
  definition,
  blendedNote,
  comparisonUnavailable = 'no comparable previous period',
}: {
  metricLabel: string;
  channelLabel: string;
  cost: ChannelCostPerDeal;
  previousCost: ChannelCostPerDeal | null;
  currency: string;
  direction: ImprovementDirection | null;
  points: SeriesPoint[];
  target: { value: number; label: string } | null;
  secondary: SecondaryFigure[];
  periodToggle: ReactNode;
  provisional: boolean;
  definition: string | null;
  /** Why no blended figure appears. Carried in the ⓘ, never on the card. */
  blendedNote: string;
  /** Why the comparison is absent, when it is. */
  comparisonUnavailable?: string;
}) {
  return (
    <Card span={8}>
      <CardHeader
        title={metricLabel}
        subtitle={`${channelLabel} · north star`}
        info={
          <InfoTip label={`How ${metricLabel} is measured`} align="start">
            {definition ? `${definition} ` : ''}
            {blendedNote}
          </InfoTip>
        }
        controls={
          <>
            {provisional && <ProvisionalBadge />}
            {periodToggle}
          </>
        }
      />

      <div className="px-5">
        <CostPerDealFigure
          cost={cost}
          currency={currency}
          channelLabel={channelLabel}
          size="hero"
        />
        <div className="mt-1.5">
          {cost.value !== null ? (
            <Delta
              current={cost.value}
              baseline={previousCost?.value ?? null}
              direction={direction}
              unavailable={comparisonUnavailable}
            />
          ) : (
            <NoDelta reason="nothing to compare" />
          )}
        </div>
      </div>

      {secondary.length > 0 && (
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border px-5 pt-3 sm:grid-cols-4">
          {secondary.map((figure) => (
            <div key={figure.label} className="min-w-0">
              <dt className="text-[12px] font-medium text-text-3">{figure.label}</dt>
              <dd className="mt-0.5 text-[16px] font-semibold tabular text-text">
                {figure.value ?? '—'}
              </dd>
              <dd className="mt-0.5">
                {figure.current !== null && figure.baseline !== null ? (
                  <Delta
                    current={figure.current}
                    baseline={figure.baseline}
                    direction={direction}
                    comparison="vs prior month"
                    className="text-[12px]"
                  />
                ) : (
                  <p className="text-[12px] text-text-3">no prior month</p>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-2 flex-1 px-2 pb-3">
        <AreaSeries
          id="hero-north-star"
          points={points}
          format={{ kind: 'currency', currency }}
          target={target}
          height={260}
        />
      </div>
    </Card>
  );
}
