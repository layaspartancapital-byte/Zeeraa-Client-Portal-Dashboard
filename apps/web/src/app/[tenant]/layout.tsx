import type { Metadata } from 'next';
import { AppShell } from '@/components/shell/AppShell';

import { requireTenant } from '@/lib/tenant';
import { hasCompletedTour, recordTourCompleted } from '@/lib/tour';
import { integratingPlatforms, reportingPlatforms, tenantBusinessHours, tenantLogo } from '@/lib/cached-reports';

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

  const [platforms, integrating, brand, toured, refreshHours] = await Promise.all([
    reportingPlatforms(session),
    integratingPlatforms(session),
    tenantLogo(session),
    hasCompletedTour(session),
    tenantBusinessHours(session),
  ]);

  // Finished or skipped, recorded for this user wherever they sign in next.
  async function completeTour(): Promise<void> {
    'use server';
    await recordTourCompleted(await requireTenant(slug));
  }

  return (
    <AppShell
      viewer={session.viewer}
      tenant={session.tenant}
      logo={brand.logo}
      mark={brand.mark}
      platforms={platforms.map((p) => ({ key: p.key, label: p.label }))}
      integrating={integrating}
      generatedAt={new Date().toLocaleString('en-US', { timeZone: session.tenant.timezone })}
      tour={{ autoStart: !toured, onComplete: completeTour }}
      refreshHours={refreshHours}
    >
      {children}
    </AppShell>
  );
}
