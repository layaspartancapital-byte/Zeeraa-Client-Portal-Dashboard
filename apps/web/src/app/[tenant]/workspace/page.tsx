import { asc, eq } from 'drizzle-orm';
import { schema } from '@zeeraa/db';
import { Panel, EmptyState } from '@/components/Panel';
import { queryTenant, requireTenant } from '@/lib/tenant';

export const metadata = { title: 'Workspace' };

export default async function Workspace({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const session = await requireTenant(slug);

  const types = await queryTenant(session, (tx) =>
    tx
      .select()
      .from(schema.assetTypes)
      .where(eq(schema.assetTypes.tenantId, session.tenant.id))
      .orderBy(asc(schema.assetTypes.position)),
  );

  return (
    <Panel
      title="Content and approvals"
      description={`${types.length} asset types configured for this client.`}
    >
      <EmptyState
        heading="Nothing has been submitted yet"
        body="Zeeraa uploads work here, links it to a commitment and period, and mentions the person responsible. That person reviews and approves in place, and an approved asset becomes the evidence behind a delivery count."
        needed="Phase 5 builds uploads, versioning, mentions and the approval flow."
      />
    </Panel>
  );
}
