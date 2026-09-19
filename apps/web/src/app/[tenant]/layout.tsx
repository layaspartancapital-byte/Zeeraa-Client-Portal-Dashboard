import type { Metadata } from 'next';
import { AppShell } from '@/components/shell/AppShell';
import { reportingPlatforms } from '@/lib/platforms';
import { requireTenant } from '@/lib/tenant';

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

  const platforms = await reportingPlatforms(session);

  return (
    <AppShell
      viewer={session.viewer}
      tenant={session.tenant}
      platforms={platforms.map((p) => ({ key: p.key, label: p.label }))}
      generatedAt={new Date().toLocaleString('en-US', { timeZone: session.tenant.timezone })}
    >
      {children}
    </AppShell>
  );
}
