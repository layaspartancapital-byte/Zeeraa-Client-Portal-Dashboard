import { eq } from 'drizzle-orm';
import { schema } from '@zeeraa/db';
import { Panel, EmptyState } from '@/components/Panel';
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
 * Phase 1 has no ingested data, so the north-star band renders its empty state
 * rather than a zero. A zero here would be a measurement — it would say the
 * cost per funded deal is nothing — and that is worse than saying nothing.
 */
export default async function ExecutiveView({
  params,
}: {
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: slug } = await params;
  const session = await requireTenant(slug);

  const [northStar] = await queryTenant(session, (tx) =>
    tx
      .select()
      .from(schema.tenantMetrics)
      .where(eq(schema.tenantMetrics.isNorthStar, true))
      .limit(1),
  );

  return (
    <div className="space-y-6">
      {/* The one place in the application that spends any visual drama. */}
      <section className="bg-night px-5 py-8 text-paper sm:px-8 sm:py-10">
        <p className="text-[12px] text-paper/60">{northStar?.label ?? 'North-star metric'}</p>
        <p className="mt-3 font-display text-[44px] leading-none text-paper/35 sm:text-[56px]">
          Not yet measurable
        </p>
        <p className="mt-4 max-w-prose text-[12px] leading-relaxed text-paper/70">
          {northStar
            ? `${northStar.definition} No ad spend or funded deals have been ingested yet, so this figure has no source to resolve to.`
            : 'No north-star metric is configured for this client.'}
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
        description="Funded volume, total program cost, funded deals, offer rate."
      >
        <EmptyState
          heading="Nothing to report yet"
          body="These four figures come from the join between ad platform spend and Salesforce funded deals. Neither side is connected."
          needed="Salesforce and Google Ads connections, then one completed sync."
        />
      </Panel>

      <Panel title="Cost per funded deal over time">
        <EmptyState
          heading="No series to draw"
          body="This chart plots the north-star metric by month with the target drawn as a brass line. It needs at least one month of joined spend and funded deals."
          needed="A completed Salesforce sync and a completed Google Ads sync covering the same period."
        />
      </Panel>
    </div>
  );
}
