'use client';

import type { TenantSummary, Viewer } from '@/lib/tenant';
import { ShellProvider, useShell } from '@/components/shell/shell-state';
import { Sidebar } from '@/components/shell/Sidebar';

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
  children,
}: {
  viewer: Viewer;
  tenant: TenantSummary;
  /** Serialised by the server component that renders this. */
  generatedAt: string;
  children: React.ReactNode;
}) {
  return (
    <ShellProvider>
      <div className="min-h-dvh bg-canvas">
        <Sidebar viewer={viewer} tenant={tenant} />
        <Content tenant={tenant} generatedAt={generatedAt}>
          {children}
        </Content>
      </div>
    </ShellProvider>
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
