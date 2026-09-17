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
 */
export default async function Funnel({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const session = await requireTenant(slug);

  const stages = await queryTenant(session, (tx) =>
    tx
      .select()
      .from(schema.funnelStages)
      .where(eq(schema.funnelStages.tenantId, session.tenant.id))
      .orderBy(asc(schema.funnelStages.position)),
  );

  return (
    <div className="space-y-6">
      <Panel
        title="Stage flow"
        description="Configured for this client. Conversion rates render in the gaps once opportunities are ingested."
      >
        <div className="table-scroll overflow-x-auto">
          <div className="flex min-w-max items-stretch px-5 py-6">
            {stages.map((stage, i) => (
              <div key={stage.key} className="flex items-stretch">
                <div className="min-w-[128px]">
                  <p
                    className={`pb-1 text-[13px] text-ink ${
                      stage.isOptimizationTarget ? 'border-b-2 border-brass' : ''
                    }`}
                  >
                    {stage.label}
                  </p>
                  <p className="mt-2 text-[13px] text-graphite">No data</p>
                  {stage.isOptimizationTarget && (
                    <p className="mt-1 text-[11px] text-graphite">Optimization target</p>
                  )}
                </div>
                {i < stages.length - 1 && (
                  <div className="flex w-20 shrink-0 flex-col items-center justify-start pt-0.5 text-graphite">
                    <span className="text-[11px]">—</span>
                    <span className="mt-1 text-[10px]">rate</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </Panel>

      <Panel title="Breakdown">
        <EmptyState
          heading="No opportunities ingested"
          body="The breakdown slices by platform, campaign, product, industry and state, on either attribution model. Industry and state matter most here: approval rates vary sharply by both."
          needed="A Salesforce connection with stage-transition timestamps."
        />
      </Panel>
    </div>
  );
}
