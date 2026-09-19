import type { Metadata } from 'next';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema } from '@zeeraa/db';
import { AppShell } from '@/components/shell/AppShell';
import { platformLabel } from '@/lib/reporting';
import { queryTenant, requireTenant } from '@/lib/tenant';

/**
 * Ad platforms this client has connected and that are reporting.
 *
 * `healthy` only, and only platforms with a connector: a rail entry is a
 * promise that a page has something to show, and a `not_configured` row is a
 * placeholder for a connector that does not exist yet.
 */
const AD_PLATFORMS = ['google_ads', 'meta', 'microsoft_ads', 'linkedin_ads'];

/**
 * The browser tab title leads with the tenant name. Two tabs open on two
 * lenders have to be distinguishable from the tab strip alone, before anything
 * is read.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ tenant: string }>;
}): Promise<Metadata> {
  const { tenant: slug } = await params;
  const { tenant } = await requireTenant(slug);
  return { title: { template: `${tenant.name} · %s`, default: tenant.name } };
}

export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: slug } = await params;
  const session = await requireTenant(slug);

  const connected = await queryTenant(session, (tx) =>
    tx
      .select({ platform: schema.connections.platform })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.tenantId, session.tenant.id),
          eq(schema.connections.status, 'healthy'),
          inArray(schema.connections.platform, AD_PLATFORMS),
        ),
      )
      .orderBy(asc(schema.connections.platform)),
  );

  return (
    <AppShell
      viewer={session.viewer}
      tenant={session.tenant}
      platforms={connected.map((c) => ({ key: c.platform, label: platformLabel(c.platform) }))}
      generatedAt={new Date().toLocaleString('en-US', { timeZone: session.tenant.timezone })}
    >
      {children}
    </AppShell>
  );
}
