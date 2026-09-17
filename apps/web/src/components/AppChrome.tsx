import Link from 'next/link';
import { canSwitchTenant, isZeeraaRole, ROLE_LABELS } from '@zeeraa/core';
import type { TenantSummary, Viewer } from '@/lib/tenant';
import { TenantSwitcher } from './TenantSwitcher';
import { NavBar } from './NavBar';

/**
 * The application chrome.
 *
 * Tenant identity is carried by three things that are always present: the 3px
 * accent stripe across the top of the viewport, the client's name at top left
 * outside any menu, and the tab title. None of them is ever behind an
 * interaction.
 */
export function AppChrome({
  viewer,
  tenant,
  children,
  generatedAt,
}: {
  viewer: Viewer;
  tenant: TenantSummary;
  children: React.ReactNode;
  generatedAt: Date;
}) {
  // Shown for Zeeraa roles whatever the count: it is where a Zeeraa user
  // confirms which client they are looking at, not only where they change it.
  // Client roles never see it.
  const showSwitcher = canSwitchTenant(tenant.role);

  return (
    <>
      <div
        className="tenant-stripe fixed inset-x-0 top-0 z-50 h-[3px]"
        style={{ background: tenant.accentColor }}
        aria-hidden="true"
      />

      <header className="print-hidden sticky top-0 z-40 border-b border-rule bg-paper/95 pt-[3px] backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-medium text-ink">{tenant.name}</h1>
            <p className="truncate text-[11px] text-graphite">
              {ROLE_LABELS[tenant.role]}
              {isZeeraaRole(tenant.role) ? ' · Zeeraa' : ''}
            </p>
          </div>

          {showSwitcher && <TenantSwitcher tenants={viewer.tenants} current={tenant} />}

          <div className="flex items-center gap-3 text-[12px] text-graphite">
            <span className="hidden max-w-[180px] truncate sm:inline">{viewer.email}</span>
            <Link
              href="/signout"
              className="rounded-[4px] border border-rule px-2 py-1 transition-colors hover:text-ink"
            >
              Sign out
            </Link>
          </div>
        </div>

        <NavBar slug={tenant.slug} role={tenant.role} />
      </header>

      {/* Printed for quarterly reviews: the header the screen version hides. */}
      <div className="print-header hidden">
        <p className="text-[13px] font-medium">{tenant.name}</p>
        <p className="text-[11px]">
          Generated {generatedAt.toLocaleString('en-US', { timeZone: tenant.timezone })} ·{' '}
          {tenant.timezone}
        </p>
      </div>

      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">{children}</main>

      <footer className="print-hidden mx-auto max-w-[1400px] border-t border-rule px-4 py-4 text-[11px] text-graphite sm:px-6">
        Zeeraa performance platform · All figures resolve to a named source.
      </footer>
    </>
  );
}
