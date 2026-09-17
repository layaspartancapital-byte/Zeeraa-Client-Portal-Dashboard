import { eq } from 'drizzle-orm';
import { schema } from '@zeeraa/db';
import { formatCount, formatCurrency, tenantDay, trailingWindow } from '@zeeraa/core';
import { Panel, EmptyState } from '@/components/Panel';
import { CostPerDealDisplay } from '@/components/CostPerDeal';
import { monthlyPerformance, platformLabel } from '@/lib/reporting';
import { queryTenant, requireTenant } from '@/lib/tenant';

/**
 * A page in the same segment as its layout does not inherit that layout's title
 * template, so the tenant name is set here explicitly. Every tab in the strip
 * has to name its client.
 */
export async function generateMetadata({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const { tenant } = await requireTenant(slug);
  return { title: { absolute: `${tenant.name} · Executive` } };
}

/**
 * The executive view.
 *
 * The brief puts one north-star figure in the dark band. What renders there is
 * one *channel's* cost per funded deal, named as one channel's, with its
 * coverage and its range — because a blended figure across every channel has a
 * different denominator and is not computable until every channel is ingested.
 * Showing the one live channel's number under a blended label would be the most
 * expensive kind of quiet error: right arithmetic, wrong noun, on the screen the
 * client repeats internally.
 *
 * The absence is stated rather than left to be inferred.
 */
export default async function ExecutiveView({
  params,
}: {
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: slug } = await params;
  const session = await requireTenant(slug);

  const today = tenantDay(new Date(), session.tenant.timezone);
  const range = trailingWindow(today, 90);

  const [northStarRows, data] = await Promise.all([
    queryTenant(session, (tx) =>
      tx
        .select()
        .from(schema.tenantMetrics)
        .where(eq(schema.tenantMetrics.isNorthStar, true))
        .limit(1),
    ),
    monthlyPerformance(session, range, 'last_touch'),
  ]);

  const northStar = northStarRows[0];
  const currency = session.tenant.currency;

  // The channel carrying the most spend in the window is the one the band
  // speaks for. Named explicitly, never implied — and when a second channel
  // arrives this is where the blended figure will replace it.
  const lead = [...data.channels].sort((a, b) => b.spend - a.spend)[0];
  const otherChannels = data.channels.filter((c) => c.platform !== lead?.platform);

  const valueStage = data.stages.find((s) => s.countsValue);
  const valueLabel = valueStage?.label ?? 'Funded';

  return (
    <div className="space-y-6">
      <section className="bg-night px-5 py-8 text-paper sm:px-8 sm:py-10">
        {lead ? (
          <CostPerDealDisplay
            cost={lead.costPerDeal}
            currency={currency}
            label={northStar?.label ?? `Cost per ${valueLabel.toLowerCase()} deal`}
            channelLabel={lead.label}
          />
        ) : (
          <div>
            <p className="text-[12px] text-paper/60">
              {northStar?.label ?? 'North-star metric'}
            </p>
            <p className="mt-3 font-display text-[44px] leading-none text-paper/35 sm:text-[56px]">
              Not yet measurable
            </p>
            <p className="mt-4 max-w-prose text-[12px] leading-relaxed text-paper/70">
              {northStar
                ? `${northStar.definition} No channel has reported spend in the last 90 days, so this figure has no source to resolve to.`
                : 'No north-star metric is configured for this client.'}
            </p>
          </div>
        )}

        {/*
          The blended figure is absent on purpose. Saying so on the band itself
          is the difference between a metric that is not ready and a metric the
          reader assumes they are already looking at.
        */}
        <p className="mt-6 max-w-prose border-l-2 border-brass-bright pl-3 text-[12px] leading-relaxed text-paper/70">
          This is one channel&rsquo;s figure, not a blended one. Blended cost per{' '}
          {valueLabel.toLowerCase()} deal divides total marketing spend by total marketing-sourced
          deals, and needs every channel in the engagement ingested before it means anything.{' '}
          {otherChannels.length > 0
            ? `${otherChannels.length} other ${
                otherChannels.length === 1 ? 'channel is' : 'channels are'
              } reporting; the rest of the engagement is not yet connected.`
            : 'No other channel is connected yet.'}
        </p>

        {northStar?.needsReconciliation && (
          <p className="mt-3 max-w-prose border-l-2 border-brass-bright pl-3 text-[12px] leading-relaxed text-paper/70">
            The target for this metric is unreconciled and is deliberately not shown.{' '}
            {northStar.reconciliationNote}
          </p>
        )}
      </section>

      <Panel
        title="Supporting figures"
        description={`Trailing 90 days, ${range.start} to ${range.end}.`}
      >
        <dl className="grid grid-cols-1 divide-y divide-rule sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4">
          <Figure
            label={`${valueLabel} volume`}
            value={formatCurrency(data.total.valueVolume, currency)}
            referent="every source, attributed or not"
          />
          <Figure
            label="Paid media spend"
            value={formatCurrency(data.total.spend, currency)}
            referent={`${data.channels.length} connected ${
              data.channels.length === 1 ? 'channel' : 'channels'
            }`}
          />
          <Figure
            label={`${valueLabel} deals`}
            value={formatCount(
              valueStage ? (data.total.stages[valueStage.key] ?? 0) : 0,
            )}
            referent={
              valueStage
                ? `${formatCount(
                    data.channels.reduce(
                      (sum, c) => sum + (c.stages[valueStage.key] ?? 0),
                      0,
                    ),
                  )} attributed to a channel, ${formatCount(
                    data.unattributed.stages[valueStage.key] ?? 0,
                  )} to none`
                : 'no value stage configured'
            }
          />
          <Figure
            label="Attributed share"
            value={
              valueStage && (data.total.stages[valueStage.key] ?? 0) > 0
                ? `${Math.round(
                    (data.channels.reduce(
                      (sum, c) => sum + (c.stages[valueStage.key] ?? 0),
                      0,
                    ) /
                      (data.total.stages[valueStage.key] ?? 1)) *
                      100,
                  )}%`
                : '—'
            }
            referent="of deals that reach a channel at all"
          />
        </dl>
      </Panel>

      <Panel title={`Cost per ${valueLabel.toLowerCase()} deal over time`}>
        <EmptyState
          heading="No series to draw"
          body="This chart plots the north-star metric by month with the target drawn as a brass line, one line per channel and never a blended one. It needs several months of joined spend and funded deals."
          needed="Nothing from the client — this is Zeeraa's build work, and it follows the monthly table."
        />
      </Panel>
    </div>
  );
}

/**
 * Every figure carries a referent. A number alone on the executive view is the
 * one the client quotes, so it does not appear alone.
 */
function Figure({
  label,
  value,
  referent,
}: {
  label: string;
  value: string;
  referent: string;
}) {
  return (
    <div className="px-5 py-5">
      <dt className="text-[12px] text-graphite">{label}</dt>
      <dd className="mt-1.5 figure-display text-[26px] leading-none text-ink">{value}</dd>
      <dd className="mt-1.5 text-[11px] leading-relaxed text-graphite tabular-nums">{referent}</dd>
    </div>
  );
}
