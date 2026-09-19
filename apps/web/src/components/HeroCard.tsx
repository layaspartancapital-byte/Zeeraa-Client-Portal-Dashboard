import type { ReactNode } from 'react';
import type { ChannelCostPerDeal, ImprovementDirection } from '@zeeraa/core';
import { Card, CardHeader } from '@/components/ui/Card';
import { Delta, NoDelta } from '@/components/ui/Delta';
import { InfoTip } from '@/components/ui/InfoTip';
import { ProvisionalBadge } from '@/components/ui/Badge';
import { CostPerDealFigure } from '@/components/CostPerDeal';
import { MiniChart, type MiniPoint } from '@/components/charts/MiniChart';

export type HeroChannel = {
  platform: string;
  label: string;
  cost: ChannelCostPerDeal;
  /** Null where the previous period predates ingestion. */
  previousCost: ChannelCostPerDeal | null;
  /** This channel's own series — never a share of a combined one. */
  points: MiniPoint[];
  provisional: boolean;
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
  periodToggle,
  definition,
  blendedNote,
  target,
}: {
  metricLabel: string;
  /** Every connected channel with spend in the window, in a stable order. */
  channels: HeroChannel[];
  currency: string;
  direction: ImprovementDirection | null;
  comparisonUnavailable?: string;
  periodToggle: ReactNode;
  definition: string | null;
  /** Why no blended figure appears. Carried in the ⓘ, never on the card. */
  blendedNote: string;
  /**
   * The engagement's target, where one is configured and reconciled.
   *
   * Stated once on the card and deliberately **not** drawn on either channel's
   * chart. The engagement states one number; configuration carries no per
   * channel target, and a line drawn across both panels would assert that each
   * channel is independently held to it — which is a claim nobody has made.
   */
  target: { label: string; note: string } | null;
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
        controls={
          <>
            {target && (
              <span className="inline-flex items-center gap-1 text-[12px] font-medium text-text-2 tabular">
                {target.label}
                <InfoTip label="What this target applies to" align="center">
                  {target.note}
                </InfoTip>
              </span>
            )}
            {periodToggle}
          </>
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

      {/* Anchored to the bottom of the panel so both channels' series sit on
          one baseline and are read against each other rather than floating at
          different heights. */}
      <div className="mt-2 flex flex-1 items-end">
        <MiniChart
          points={channel.points}
          height={150}
          label={`${metricLabel}, ${channel.label}`}
        />
      </div>
    </section>
  );
}
