import { asc, eq } from 'drizzle-orm';
import { schema } from '@zeeraa/db';
import { Panel } from '@/components/Panel';
import { canAdministerTenant } from '@zeeraa/core';
import { queryTenant, requireRole } from '@/lib/tenant';

export const metadata = { title: 'Admin' };

type Claim = { value: string; source: string };

/**
 * Unreconciled figures.
 *
 * Several numbers in the engagement paperwork are stated two ways. Rendering
 * either version as committed progress would be a fabrication, so they sit here
 * until somebody decides. Nothing downstream may read an unresolved item.
 */
export default async function Admin({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const session = await requireRole(slug, canAdministerTenant);

  const [items, metrics] = await Promise.all([
    queryTenant(session, (tx) =>
      tx
        .select()
        .from(schema.reconciliationItems)
        .where(eq(schema.reconciliationItems.tenantId, session.tenant.id))
        .orderBy(asc(schema.reconciliationItems.key)),
    ),
    queryTenant(session, (tx) =>
      tx
        .select()
        .from(schema.tenantMetrics)
        .where(eq(schema.tenantMetrics.needsReconciliation, true)),
    ),
  ]);

  return (
    <div className="space-y-6">
      <Panel
        title="Figures stated two ways"
        description="Each of these appears twice in the engagement paperwork with different values. None is rendered as progress anywhere in the product until it is settled."
      >
        <ul className="divide-y divide-rule">
          {items.map((item) => (
            <li key={item.key} className="px-5 py-4">
              <p className="text-[13px] text-ink">{item.label}</p>
              <p className="mt-1 max-w-prose text-[12px] leading-relaxed text-graphite">
                {item.question}
              </p>
              <ul className="mt-2.5 space-y-1">
                {(item.claims as Claim[]).map((claim, i) => (
                  <li key={i} className="flex flex-wrap gap-x-2 text-[12px]">
                    <span className="text-ink">{claim.value}</span>
                    <span className="text-graphite">— {claim.source}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-provisional">
                {item.resolvedValue ? `Settled as ${item.resolvedValue}` : 'Unresolved'}
              </p>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel
        title="Metrics with unreconciled targets"
        description="These metrics still compute; only their target is withheld."
      >
        <ul className="divide-y divide-rule">
          {metrics.map((m) => (
            <li key={m.key} className="px-5 py-3">
              <p className="text-[13px] text-ink">{m.label}</p>
              <p className="mt-0.5 max-w-prose text-[12px] leading-relaxed text-graphite">
                {m.reconciliationNote}
              </p>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
