import { eq } from 'drizzle-orm';
import { schema } from '@zeeraa/db';
import { trailingWindow, tenantDay, type AttributionModel } from '@zeeraa/core';
import { Panel, EmptyState } from '@/components/Panel';
import { PerformanceTable } from '@/components/PerformanceTable';
import {
  CostPerDealByChannel,
  MonthOverMonth,
  SpendAndDealsOverTime,
  StageComposition,
} from '@/components/charts/Charts';
import { monthlyPerformance, monthlySeries } from '@/lib/reporting';
import { queryTenant, requireTenant } from '@/lib/tenant';

export const metadata = { title: 'Monthly performance' };

const MODELS: { key: AttributionModel; label: string }[] = [
  { key: 'last_touch', label: 'Last touch' },
  { key: 'first_touch', label: 'First touch' },
];

/**
 * The workhorse reporting screen.
 *
 * One row per channel, an explicit unattributed row that is not a channel, and
 * a totals row that renders nothing where a total would be a category error.
 * See `docs/brief-amendments.md`, "§9.2 and §12 — the separation rule is a
 * layout rule too".
 */
export default async function Performance({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{ model?: string; days?: string }>;
}) {
  const { tenant: slug } = await params;
  const { model: modelParam, days: daysParam } = await searchParams;
  const session = await requireTenant(slug);

  const model: AttributionModel = modelParam === 'first_touch' ? 'first_touch' : 'last_touch';
  const days = Number(daysParam) > 0 ? Math.min(Number(daysParam), 365) : 90;

  const today = tenantDay(new Date(), session.tenant.timezone);
  const range = trailingWindow(today, days);

  const [data, series, targetRows] = await Promise.all([
    monthlyPerformance(session, range, model),
    monthlySeries(session, 12, model),
    queryTenant(session, (tx) =>
      tx
        .select({ targetValue: schema.tenantMetrics.targetValue, needsReconciliation: schema.tenantMetrics.needsReconciliation })
        .from(schema.tenantMetrics)
        .where(eq(schema.tenantMetrics.isNorthStar, true))
        .limit(1),
    ),
  ]);

  const channelKeys = data.channels.map((c) => c.platform);
  const valueLabel = data.stages.find((s) => s.countsValue)?.label ?? 'Funded';
  // An unreconciled target is not drawn. §13: a target the source material
  // contradicts is worse than no target, because a brass line on a chart reads
  // as a commitment somebody made.
  const northStar = targetRows[0];
  const target =
    northStar && !northStar.needsReconciliation && northStar.targetValue
      ? Number(northStar.targetValue)
      : null;

  const hasAnything =
    data.channels.length > 0 || Object.keys(data.unattributed.stages).length > 0;

  return (
    <div className="space-y-6">
      <Panel
        title="Monthly performance"
        description={`${range.start} to ${range.end}, in ${session.tenant.timezone}.`}
        aside={
          data.dataThrough
            ? `Data through ${data.dataThrough.toISOString().slice(0, 16).replace('T', ' ')} UTC`
            : 'No completed sync'
        }
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-rule px-5 py-3 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="text-graphite">Attribution model</span>
            {MODELS.map((m) => (
              <a
                key={m.key}
                href={`?model=${m.key}&days=${days}`}
                aria-current={m.key === model ? 'true' : undefined}
                className={`rounded-[4px] px-2 py-1 ${
                  m.key === model ? 'bg-ink text-paper' : 'text-graphite hover:text-ink'
                }`}
              >
                {m.label}
              </a>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-graphite">Window</span>
            {[30, 90, 365].map((d) => (
              <a
                key={d}
                href={`?model=${model}&days=${d}`}
                aria-current={d === days ? 'true' : undefined}
                className={`rounded-[4px] px-2 py-1 tabular-nums ${
                  d === days ? 'bg-ink text-paper' : 'text-graphite hover:text-ink'
                }`}
              >
                {d} days
              </a>
            ))}
          </div>
        </div>

        {hasAnything ? (
          <PerformanceTable data={data} currency={session.tenant.currency} />
        ) : (
          <EmptyState
            heading="No platform has reported in this window"
            body="This table reports spend, impressions, clicks, CTR, CPC and every funnel stage through to funded volume, per channel, with an explicit row for deals no channel can claim."
            needed="At least one ad platform connection and one completed sync covering this period."
          />
        )}
      </Panel>

      <Panel
        title="Spend and funded deals over time"
        description="Two plots, one x-axis. Deliberately not one plot with two y-scales: spend is in tens of thousands and deals in tens, so any apparent relationship between the lines would be an artefact of the scaling."
      >
        {series.length > 0 ? (
          <SpendAndDealsOverTime
            series={series}
            channels={channelKeys}
            currency={session.tenant.currency}
            valueLabel={valueLabel}
          />
        ) : (
          <EmptyState
            heading="No months to plot"
            body="This chart needs at least one calendar month of ingested spend or funded deals."
            needed="A completed sync."
          />
        )}
      </Panel>

      <Panel
        title={`Cost per ${valueLabel.toLowerCase()} deal by channel`}
        description="Each bar is the range the data supports, not a point. A short bar is a well-covered figure."
      >
        <CostPerDealByChannel
          rows={data.channels.map((c) => ({
            label: c.label,
            platform: c.platform,
            cost: c.costPerDeal,
          }))}
          currency={session.tenant.currency}
          target={target}
        />
      </Panel>

      <Panel
        title="Funnel-stage composition by channel"
        description="Unattributed is its own segment. Blocked stages are absent rather than drawn at zero."
      >
        <StageComposition data={data} />
      </Panel>

      <Panel title="Month-over-month change" description="Every figure carries its sign.">
        <MonthOverMonth
          series={series}
          channels={channelKeys}
          currency={session.tenant.currency}
          improvementDirection="up"
        />
      </Panel>
    </div>
  );
}
