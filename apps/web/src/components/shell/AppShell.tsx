'use client';

import type { BusinessHours } from '@zeeraa/core';
import type { TenantSummary, Viewer } from '@/lib/tenant';
import { RefreshHoursProvider } from '@/components/shell/AutoRefresh';
import { ShellProvider, useShell } from '@/components/shell/shell-state';
import { Sidebar } from '@/components/shell/Sidebar';
import { TourProvider } from '@/components/shell/ProductTour';

/**
 * Sidebar, canvas and the content column.
 *
 * The content column is offset by the rail's width on `lg` and up, and runs
 * full-bleed below that breakpoint where the rail is off-canvas. Max width
 * 1440px, left-aligned, 24px gutters — the grid the cards sit in (spec v2 §3).
 *
 * The top bar is not here: each page renders its own so it can carry that
 * page's title and its own controls.
 */
export function AppShell({
  viewer,
  tenant,
  generatedAt,
  platforms,
  logo = null,
  mark = null,
  integrating = [],
  tour,
  refreshHours,
  children,
}: {
  viewer: Viewer;
  tenant: TenantSummary;
  /** The tenant's own logo as a `data:` URL; null shows its initials. */
  logo?: string | null;
  /** The tenant's square mark for the collapsed rail; null shows a monogram. */
  mark?: string | null;
  /** Platforms being connected, drawn as "Integrating" until they report. */
  integrating?: { key: string; label: string }[];
  /** Serialised by the server component that renders this. */
  generatedAt: string;
  /** Connected ad platforms, resolved server-side in the tenant layout. */
  platforms?: { key: string; label: string }[];
  /** The product tour: whether it starts on its own, and how completion is recorded. */
  tour: { autoStart: boolean; onComplete: () => Promise<void> };
  /** The desk's hours, which set how often `AutoRefresh` refreshes; null is 24/7. */
  refreshHours: BusinessHours | null;
  children: React.ReactNode;
}) {
  return (
    <RefreshHoursProvider hours={refreshHours}>
    <ShellProvider>
      <TourProvider slug={tenant.slug} autoStart={tour.autoStart} onComplete={tour.onComplete}>
        <div className="min-h-dvh bg-canvas">
          <Sidebar viewer={viewer} tenant={tenant} platforms={platforms} logo={logo} mark={mark} integrating={integrating} />
          <Content tenant={tenant} generatedAt={generatedAt}>
            {children}
          </Content>
        </div>
      </TourProvider>
    </ShellProvider>
    </RefreshHoursProvider>
  );
}

/** Follows the rail's width, so collapsing it widens the grid rather than
    leaving a 176px gutter of canvas. */
function Content({
  tenant,
  generatedAt,
  children,
}: {
  tenant: TenantSummary;
  generatedAt: string;
  children: React.ReactNode;
}) {
  const { collapsed } = useShell();

  return (
    <div
      data-content
      className={`transition-[padding] duration-200 ${collapsed ? 'lg:pl-16' : 'lg:pl-60'}`}
    >
      <div className="mx-auto w-full max-w-[1440px] px-4 pb-10 sm:px-6">
        {/* Printed for quarterly reviews: the header the screen hides. */}
        <div className="print-header hidden">
          <p className="text-[12px] font-semibold">{tenant.name}</p>
          <p className="text-[10px]">
            Generated {generatedAt} · {tenant.timezone}
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}
