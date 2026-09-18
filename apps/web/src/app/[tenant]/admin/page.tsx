import { asc, eq } from 'drizzle-orm';
import { schema } from '@zeeraa/db';
import { canAdministerTenant } from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine, Grid } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { TopBar } from '@/components/shell/TopBar';
import { PrintButton } from '@/components/shell/actions';
import { DataQualityCard } from '@/components/DataQualityCard';
import { dataQuality, unreadNotifications } from '@/lib/dashboard';
import { queryTenant, requireRole } from '@/lib/tenant';

export const metadata = { title: 'Reconciliation' };

type Claim = { value: string; source: string };

/**
 * Unreconciled figures.
 *
 * Several numbers in the engagement paperwork are stated two ways. Rendering
 * either version as committed progress would be a fabrication, so they sit here
 * until somebody decides, and nothing downstream may read an unresolved item —
 * which is why no target line is drawn on the executive chart today.
 */
export default async function Admin({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const session = await requireRole(slug, canAdministerTenant);

  const [items, metrics, quality, unread] = await Promise.all([
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
        .where(eq(schema.tenantMetrics.needsReconciliation, true))
        .orderBy(asc(schema.tenantMetrics.key)),
    ),
    dataQuality(session),
    unreadNotifications(session),
  ]);

  const unresolved = items.filter((item) => !item.resolvedValue);

  return (
    <>
      <TopBar
        tenant={session.tenant}
        viewer={session.viewer}
        title="Reconciliation"
        unread={unread}
      >
        <PrintButton />
      </TopBar>

      <Grid>
        <Card span={8}>
          <CardHeader
            title="Figures stated two ways"
            subtitle={`${unresolved.length} of ${items.length} unresolved`}
            info={
              <InfoTip label="Why these are here" align="start">
                Each of these appears twice in the engagement paperwork with different values.
                None is rendered as progress anywhere in the product until it is settled.
              </InfoTip>
            }
          />
          {items.length === 0 ? (
            <CardBody>
              <EmptyLine>Nothing is stated two ways for this client.</EmptyLine>
            </CardBody>
          ) : (
            <ul className="divide-y divide-border border-t border-border">
              {items.map((item) => (
                <li key={item.key} className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="flex items-center gap-1.5 text-[13px] font-medium text-text">
                      {item.label}
                      <InfoTip label={`The question behind ${item.label}`} align="start">
                        {item.question}
                      </InfoTip>
                    </p>
                    {item.resolvedValue ? (
                      <Badge tone="up">Settled as {item.resolvedValue}</Badge>
                    ) : (
                      <Badge tone="warn">Unresolved</Badge>
                    )}
                  </div>
                  <ul className="mt-2 space-y-1">
                    {(item.claims as Claim[]).map((claim, i) => (
                      <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                        <span className="font-semibold tabular text-text">{claim.value}</span>
                        <span className="text-text-2">{claim.source}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <DataQualityCard items={quality} span={4} />

        <Card span={12}>
          <CardHeader
            title="Metrics with unreconciled targets"
            subtitle="These metrics still compute; only their target is withheld"
          />
          {metrics.length === 0 ? (
            <CardBody>
              <EmptyLine>Every configured target is reconciled.</EmptyLine>
            </CardBody>
          ) : (
            <ul className="divide-y divide-border border-t border-border">
              {metrics.map((metric) => (
                <li
                  key={metric.key}
                  className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-5 py-3"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-[13px] font-medium text-text">
                      {metric.label}
                      <InfoTip label={`Why ${metric.label} has no target drawn`} align="start">
                        {metric.reconciliationNote}
                      </InfoTip>
                    </p>
                    <p className="mt-0.5 truncate text-[12px] text-text-2">
                      {metric.reconciliationNote}
                    </p>
                  </div>
                  <Badge tone="warn">No target drawn</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </Grid>
    </>
  );
}
