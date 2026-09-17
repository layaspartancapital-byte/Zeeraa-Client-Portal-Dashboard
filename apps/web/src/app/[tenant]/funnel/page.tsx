import { asc, eq } from 'drizzle-orm';
import { schema } from '@zeeraa/db';
import { tenantDay, trailingWindow, type AttributionModel } from '@zeeraa/core';
import { Panel, EmptyState } from '@/components/Panel';
import { FunnelFlow } from '@/components/FunnelFlow';
import { monthlyPerformance } from '@/lib/reporting';
import { queryTenant, requireTenant } from '@/lib/tenant';

export const metadata = { title: 'Funnel' };

/**
 * The stage flow is drawn from configuration even with no data behind it, which
 * is the point: the engine reads `funnel_stages`, so a tenant running
 * Lead → Demo → Trial → Subscription gets the same screen with no code change.
 *
 * Conversion rates sit in the gaps between stages, because the gaps are the
 * diagnosis.
 *
 * A stage with no honest source renders as a named blocked dependency carrying
 * its reason, never as a zero. The distinction is the whole point of §9.5: a
 * zero is a measurement, and a stage nobody stamps in the CRM has not been
 * measured. The reasons are rows in `blocked_dependencies`, so unblocking one
 * is a delete rather than a deploy.
 */
export default async function Funnel({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{ channel?: string; model?: string; days?: string }>;
}) {
  const { tenant: slug } = await params;
  const { channel: channelParam, model: modelParam, days: daysParam } = await searchParams;
  const session = await requireTenant(slug);

  const model: AttributionModel = modelParam === 'first_touch' ? 'first_touch' : 'last_touch';
  const days = Number(daysParam) > 0 ? Math.min(Number(daysParam), 365) : 90;
  const today = tenantDay(new Date(), session.tenant.timezone);
  const range = trailingWindow(today, days);
  const data = await monthlyPerformance(session, range, model);

  // Which population the flow describes. Every rate on the screen takes both
  // halves from this one — a channel's rate is never its own numerator over
  // everybody's denominator.
  const populations = [
    { key: 'all', label: 'All sources', counts: data.total.stages },
    ...data.channels.map((c) => ({ key: c.platform, label: c.label, counts: c.stages })),
    { key: 'unattributed', label: 'Unattributed', counts: data.unattributed.stages },
  ];
  const population = populations.find((p) => p.key === channelParam) ?? populations[0]!;

  const [stages, blocked] = await Promise.all([
    queryTenant(session, (tx) =>
      tx
        .select()
        .from(schema.funnelStages)
        .where(eq(schema.funnelStages.tenantId, session.tenant.id))
        .orderBy(asc(schema.funnelStages.position)),
    ),
    queryTenant(session, (tx) =>
      tx
        .select()
        .from(schema.blockedDependencies)
        .where(eq(schema.blockedDependencies.tenantId, session.tenant.id))
        .orderBy(asc(schema.blockedDependencies.key)),
    ),
  ]);

  const blockedStages = new Map(
    blocked.filter((b) => b.subjectKind === 'funnel_stage').map((b) => [b.subjectKey, b]),
  );
  const blockedBreakdowns = blocked.filter((b) => b.subjectKind === 'breakdown');
  const day = (d: Date) => d.toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      <Panel
        title="Stage flow"
        description={`${range.start} to ${range.end} · ${population.label} · ${
          model === 'last_touch' ? 'last touch' : 'first touch'
        }`}
        aside={
          blockedStages.size > 0
            ? `${blockedStages.size} of ${stages.length} stages blocked`
            : undefined
        }
      >
        {/*
          The population selector. "Unattributed" is one of the options rather
          than a hidden remainder: those deals are a real population with a real
          funnel, and leaving them out of the picker would make every channel
          look like the whole business.
        */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-rule px-5 py-3 text-[12px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-graphite">Population</span>
            {populations.map((p) => (
              <a
                key={p.key}
                href={`?channel=${p.key}&model=${model}&days=${days}`}
                aria-current={p.key === population.key ? 'true' : undefined}
                className={`rounded-[4px] px-2 py-1 ${
                  p.key === population.key ? 'bg-ink text-paper' : 'text-graphite hover:text-ink'
                }`}
              >
                {p.label}
              </a>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-graphite">Model</span>
            {(['last_touch', 'first_touch'] as const).map((m) => (
              <a
                key={m}
                href={`?channel=${population.key}&model=${m}&days=${days}`}
                aria-current={m === model ? 'true' : undefined}
                className={`rounded-[4px] px-2 py-1 ${
                  m === model ? 'bg-ink text-paper' : 'text-graphite hover:text-ink'
                }`}
              >
                {m === 'last_touch' ? 'Last touch' : 'First touch'}
              </a>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-graphite">Window</span>
            {[30, 90, 365].map((d) => (
              <a
                key={d}
                href={`?channel=${population.key}&model=${model}&days=${d}`}
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

        <FunnelFlow data={data} counts={population.counts} populationLabel={population.label} />

        {blockedStages.size > 0 && (
          <div className="border-t border-rule">
            {[...blockedStages.values()].map((b) => (
              <div key={b.key} className="border-b border-rule px-5 py-4 last:border-b-0">
                <p className="text-[13px] text-ink">
                  {b.label} is not measured
                  <span className="text-provisional">
                    {' '}
                    · outstanding since {day(b.blockedSince)}
                  </span>
                </p>
                <p className="mt-1 max-w-prose text-[12px] leading-relaxed text-graphite">
                  {b.reason}
                </p>
                {b.needed && (
                  <p className="mt-2 max-w-prose text-[12px] leading-relaxed text-graphite">
                    <span className="text-ink">Needed:</span> {b.needed}
                  </p>
                )}
                {b.evidence && (
                  <p className="mt-2 max-w-prose text-[12px] leading-relaxed text-graphite">
                    <span className="text-ink">Measured:</span> {b.evidence}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Breakdown">
        <EmptyState
          heading="No opportunities ingested"
          body="The breakdown slices by platform, campaign, product, industry and state, on either attribution model. Industry and state matter most here: approval rates vary sharply by both."
          needed="A Salesforce connection with stage-transition timestamps."
        />
      </Panel>

      {blockedBreakdowns.length > 0 && (
        <Panel
          title="Slices not shown"
          description="Cut rather than rendered. Each one would look like a measurement and is not one."
        >
          {blockedBreakdowns.map((b) => (
            <div key={b.key} className="border-b border-rule px-5 py-4 last:border-b-0">
              <p className="text-[13px] text-ink">
                {b.label}
                <span className="text-provisional"> · outstanding since {day(b.blockedSince)}</span>
              </p>
              <p className="mt-1 max-w-prose text-[12px] leading-relaxed text-graphite">
                {b.reason}
              </p>
              {b.needed && (
                <p className="mt-2 max-w-prose text-[12px] leading-relaxed text-graphite">
                  <span className="text-ink">Needed:</span> {b.needed}
                </p>
              )}
              {b.evidence && (
                <p className="mt-2 max-w-prose text-[12px] leading-relaxed text-graphite">
                  <span className="text-ink">Measured:</span> {b.evidence}
                </p>
              )}
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}
