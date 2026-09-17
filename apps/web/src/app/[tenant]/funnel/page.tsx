import { asc, eq } from 'drizzle-orm';
import { schema } from '@zeeraa/db';
import { Panel, EmptyState } from '@/components/Panel';
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
export default async function Funnel({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const session = await requireTenant(slug);

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
        description="Configured for this client. Conversion rates render in the gaps once opportunities are ingested."
        aside={
          blockedStages.size > 0
            ? `${blockedStages.size} of ${stages.length} stages blocked`
            : undefined
        }
      >
        <div className="table-scroll overflow-x-auto">
          <div className="flex min-w-max items-stretch px-5 py-6">
            {stages.map((stage, i) => {
              const block = blockedStages.get(stage.key);
              const nextBlocked = stages[i + 1] && blockedStages.has(stages[i + 1]!.key);
              return (
                <div key={stage.key} className="flex items-stretch">
                  <div className="min-w-[128px] max-w-[168px]">
                    <p
                      className={`pb-1 text-[13px] ${block ? 'text-graphite' : 'text-ink'} ${
                        stage.isOptimizationTarget && !block ? 'border-b-2 border-brass' : ''
                      }`}
                    >
                      {stage.label}
                    </p>
                    {block ? (
                      <p className="mt-2 text-[13px] text-provisional">Not measured</p>
                    ) : (
                      <p className="mt-2 text-[13px] text-graphite tabular-nums">No data</p>
                    )}
                    {stage.isOptimizationTarget && (
                      <p className="mt-1 text-[11px] text-graphite">Optimization target</p>
                    )}
                  </div>
                  {i < stages.length - 1 && (
                    <div className="flex w-20 shrink-0 flex-col items-center justify-start pt-0.5 text-graphite">
                      {/* A rate into or out of an unmeasured stage is not a low
                          rate, it is no rate. Rendering a dash keeps the gap
                          visible without implying a number could go there. */}
                      <span className="text-[11px]">{block || nextBlocked ? '·' : '—'}</span>
                      <span className="mt-1 text-[10px]">
                        {block || nextBlocked ? 'n/a' : 'rate'}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

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
