import { asc, eq } from 'drizzle-orm';
import { schema } from '@zeeraa/db';
import { Panel } from '@/components/Panel';
import { queryTenant, requireTenant } from '@/lib/tenant';

export const metadata = { title: 'Delivery' };

/**
 * A compliance record, not an achievement. No checkmarks, no celebration:
 * the client is paying for this, and treating delivery as a triumph reads badly.
 */
export default async function Delivery({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const session = await requireTenant(slug);

  const [commitments, slas] = await Promise.all([
    queryTenant(session, (tx) =>
      tx
        .select()
        .from(schema.deliverableCommitments)
        .where(eq(schema.deliverableCommitments.tenantId, session.tenant.id))
        .orderBy(asc(schema.deliverableCommitments.position)),
    ),
    queryTenant(session, (tx) =>
      tx
        .select()
        .from(schema.slaCommitments)
        .where(eq(schema.slaCommitments.tenantId, session.tenant.id)),
    ),
  ]);

  return (
    <div className="space-y-6">
      <Panel
        title="Committed and delivered"
        description="Delivered counts appear once assets are published against a commitment, or recorded by hand where there is no artifact."
      >
        <div className="table-scroll overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-rule text-left text-[12px] text-graphite">
                <th scope="col" className="px-5 py-2 font-normal">Commitment</th>
                <th scope="col" className="px-5 py-2 font-normal">Committed</th>
                <th scope="col" className="px-5 py-2 font-normal">Delivered</th>
                <th scope="col" className="px-5 py-2 font-normal">Period</th>
                <th scope="col" className="px-5 py-2 font-normal">Approval</th>
              </tr>
            </thead>
            <tbody>
              {commitments.map((c) => (
                <tr key={c.key} className="border-b border-rule last:border-b-0">
                  <td className="px-5 py-2.5 text-ink">{c.label}</td>
                  <td className="px-5 py-2.5 numeric text-ink">
                    {c.committedQuantityMax
                      ? `${Number(c.committedQuantity)}–${Number(c.committedQuantityMax)}`
                      : Number(c.committedQuantity)}{' '}
                    <span className="text-graphite">{c.unit}</span>
                  </td>
                  <td className="px-5 py-2.5 numeric text-graphite">Not yet recorded</td>
                  <td className="px-5 py-2.5 text-graphite">
                    {c.period === 'monthly' ? 'Monthly' : 'Quarterly'}
                  </td>
                  <td className="px-5 py-2.5 text-graphite">
                    {c.requiresClientApproval ? 'Client approval required' : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Service levels">
        <ul className="divide-y divide-rule">
          {slas.map((s) => (
            <li key={s.type} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3">
              <span className="text-[13px] text-ink">{s.label}</span>
              <span className="text-[12px] text-graphite">
                {s.targetMinutes ? `Within ${s.targetMinutes} minutes` : s.cadence}
                {' · '}
                <span className="text-provisional">no events recorded</span>
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
