import { formatCurrency, type ChannelCostPerDeal, type ImprovementDirection, type TargetGap } from '@zeeraa/core';
import { Card, CardHeader } from '@/components/ui/Card';
import { Delta, NoDelta } from '@/components/ui/Delta';
import { InfoTip } from '@/components/ui/InfoTip';
import { ProvisionalBadge } from '@/components/ui/Badge';
import { CostPerDealFigure } from '@/components/CostPerDeal';
import { MiniChart, type MiniPoint, type SeriesTone } from '@/components/charts/MiniChart';

export type HeroChannel = {
  platform: string;
  label: string;
  cost: ChannelCostPerDeal;
  /** Null where the previous period predates ingestion. */
  previousCost: ChannelCostPerDeal | null;
  /** This channel's own series — never a share of a combined one. */
  points: MiniPoint[];
  provisional: boolean;
  /** How the measured line is coloured: the trend, by this metric's direction. */
  tone: SeriesTone;
  /**
   * The contracted ramp for this channel, where one exists.
   *
   * Null for a channel nobody contracted a target for — Meta is that channel,
   * and drawing Google Ads' curve on it would be a number with no source.
   */
  ramp: HeroChannelRamp | null;
};

export type HeroChannelRamp = {
  /**
   * The contracted figure per bucket, aligned one-to-one with `points`. Null
   * for a month the ramp does not cover.
   */
  curve: (number | null)[];
  /** Where the current figure sits against the current month's target. */
  gap: TargetGap | null;
  /** `M3` — which month of the ramp the gap belongs to. */
  monthLabel: string | null;
  /** `Dec 2026` — the calendar month, so the gap's period is never ambiguous. */
  periodLabel: string | null;
  /**
   * True where the ramp is recorded but its first month is not. The curve is a
   * shape with no position on the calendar until the engagement starts, so
   * nothing is drawn and the panel says why.
   */
  awaitingStart: boolean;
};

/**
 * The executive hero (spec v2 §6).
 *
 * **One panel per connected channel, side by side, and nothing across them.**
 *
 * The card used to render a single channel's figure, chosen as whichever spent
 * most, with a note explaining that a blended figure was not computable. With
 * two channels live that choice became a real distortion: it put Google Ads'
 * $8,797 above the fold under a heading the client reads as "what a deal costs
 * us", while Meta's $17,857 — twice the price, on a fifth of the spend — was
 * two screens away in a table.
 *
 * So there is no lead channel any more, and still no blended figure. The
 * arithmetic for one is available and it would be wrong: blended cost per deal
 * is total marketing spend over total marketing-sourced deals, which needs
 * every channel ingested and is a different denominator from any of these. Two
 * of six channels summed under a blended label is the most expensive kind of
 * quiet error — right arithmetic, wrong noun, on the screen the client repeats
 * internally.
 *
 * Each panel carries its own coverage and its own range because those are
 * properties of that channel's attribution, not of the period. Meta's range is
 * wide because one deal carries its whole spend; Google's is narrow because
 * nine do. Averaging the two would hide exactly the thing that matters.
 */
export function HeroCard({
  metricLabel,
  channels,
  currency,
  direction,
  comparisonUnavailable = 'no comparable previous period',
  definition,
  blendedNote,
}: {
  metricLabel: string;
  /** Every connected channel with spend in the window, in a stable order. */
  channels: HeroChannel[];
  currency: string;
  direction: ImprovementDirection | null;
  comparisonUnavailable?: string;
  definition: string | null;
  /** Why no blended figure appears. Carried in the ⓘ, never on the card. */
  blendedNote: string;
}) {
  return (
    <Card span={8}>
      <CardHeader
        title={metricLabel}
        subtitle={
          channels.length === 1
            ? `${channels[0]!.label} · the only connected channel`
            : `${channels.length} connected channels · never blended`
        }
        info={
          <InfoTip label={`How ${metricLabel} is measured`} align="start">
            {definition ? `${definition} ` : ''}
            {blendedNote}
          </InfoTip>
        }
      />

      <div
        className={`grid flex-1 gap-px border-t border-border bg-border ${
          channels.length > 1 ? 'sm:grid-cols-2' : 'grid-cols-1'
        }`}
      >
        {channels.map((channel) => (
          <ChannelPanel
            key={channel.platform}
            channel={channel}
            currency={currency}
            direction={direction}
            comparisonUnavailable={comparisonUnavailable}
            metricLabel={metricLabel}
          />
        ))}
      </div>
    </Card>
  );
}

/**
 * One channel's figure.
 *
 * The panels are separated by a hairline and sit on the card's own surface
 * rather than being cards of their own — a card inside a card reads as a
 * different kind of object, and these are two readings of one metric.
 */
function ChannelPanel({
  channel,
  currency,
  direction,
  comparisonUnavailable,
  metricLabel,
}: {
  channel: HeroChannel;
  currency: string;
  direction: ImprovementDirection | null;
  comparisonUnavailable: string;
  metricLabel: string;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5 bg-surface px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="truncate text-[13px] font-semibold text-text">{channel.label}</h3>
        {channel.provisional && <ProvisionalBadge />}
      </div>

      {/* Figure, coverage and range as one metric — `CostPerDealFigure` has no
          prop that takes a bare number, so the context cannot be dropped. */}
      <CostPerDealFigure
        cost={channel.cost}
        currency={currency}
        channelLabel={channel.label}
        size="hero"
      />

      <div>
        {channel.cost.value !== null ? (
          <Delta
            current={channel.cost.value}
            baseline={channel.previousCost?.value ?? null}
            direction={direction}
            unavailable={comparisonUnavailable}
          />
        ) : (
          <NoDelta reason="nothing to compare" />
        )}
      </div>

      {channel.ramp && <RampLine ramp={channel.ramp} currency={currency} />}

      {/* Anchored to the bottom of the panel so both channels' series sit on
          one baseline and are read against each other rather than floating at
          different heights. */}
      <div className="mt-2 flex flex-1 items-end">
        <MiniChart
          points={channel.points}
          height={150}
          label={`${metricLabel}, ${channel.label}`}
          tone={channel.tone}
          target={channel.ramp?.awaitingStart ? undefined : channel.ramp?.curve}
          targetLabel="contracted target"
        />
      </div>
    </section>
  );
}

/**
 * The gap to the contracted target, as a number.
 *
 * A chart shows that one line is above another; it does not say by how much,
 * and "by how much" is what the engagement is judged on. So the distance is
 * written out, with the month it belongs to, and its colour follows the same
 * `improvement_direction` as every other assessment here — a cost under target
 * is ahead and reads green while the number itself is negative.
 *
 * Where the ramp has no start month there is no target for any month, and this
 * says so in one line. Drawing the curve from an assumed start would report the
 * client against a schedule nobody has begun.
 */
function RampLine({ ramp, currency }: { ramp: HeroChannelRamp; currency: string }) {
  if (ramp.awaitingStart) {
    return (
      <p className="text-[12px] leading-snug text-text-3">
        Ramp targets begin when the engagement starts.
      </p>
    );
  }
  if (!ramp.gap) {
    return (
      <p className="text-[12px] leading-snug text-text-3">
        No completed month yet with both a target and a measured figure.
      </p>
    );
  }

  const tone =
    ramp.gap.assessment === 'ahead'
      ? 'text-up-text'
      : ramp.gap.assessment === 'shortfall'
        ? 'text-down-text'
        : 'text-text-2';
  const distance = formatCurrency(Math.abs(ramp.gap.absolute), currency);
  const target = formatCurrency(ramp.gap.target, currency);
  const month = ramp.monthLabel ? `${ramp.monthLabel} target` : 'target';

  return (
    <p className="text-[12px] leading-snug tabular text-text-3">
      {/* The period is stated because the figure above it covers the selected
          window while this gap is one month — the grain the ramp contracts. */}
      {ramp.periodLabel && <>{ramp.periodLabel} · </>}
      <span className={`font-semibold ${tone}`}>
        {ramp.gap.assessment === 'level'
          ? `on the ${month}`
          : `${distance} ${ramp.gap.assessment === 'shortfall' ? 'above' : 'below'} the ${month}`}
      </span>{' '}
      of {target}
    </p>
  );
}
