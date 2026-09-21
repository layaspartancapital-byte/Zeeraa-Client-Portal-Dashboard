'use client';

import Link from 'next/link';
import { ChevronRight, Menu } from 'lucide-react';
import type { TenantSummary, Viewer } from '@/lib/tenant';
import { useShell } from '@/components/shell/shell-state';
import { UserMenu } from '@/components/shell/Sidebar';

/**
 * The top bar (spec v2 §3).
 *
 * Rendered by each page rather than by the layout, because it carries that
 * page's title and that page's controls — the date range, the attribution
 * model, the export. It sticks to the top of the content column, which is what
 * makes it read as chrome while staying page-aware.
 *
 * It wraps to two rows below `md`: at 390px the controls cannot share a line
 * with the title, and the alternative is a horizontal scroll, which no screen
 * in this product is allowed to have.
 */
export function TopBar({
  tenant,
  viewer,
  title,
  children,
}: {
  tenant: TenantSummary;
  viewer: Viewer;
  title: string;
  /** The page's own controls: date range, model toggle, export, print, sync. */
  children?: React.ReactNode;
}) {
  const { setDrawerOpen } = useShell();

  return (
    <div
      data-topbar
      className="sticky top-0 z-30 -mx-4 mb-6 border-b border-border bg-surface px-4 sm:-mx-6 sm:px-6"
    >
      <div className="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation"
          className="-ml-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] text-text-2 hover:bg-canvas hover:text-text lg:hidden"
        >
          <Menu aria-hidden="true" className="h-5 w-5" />
        </button>

        <div className="min-w-[10rem] flex-1 lg:min-w-[13rem]">
          <nav aria-label="Breadcrumb">
            <ol className="flex items-center gap-1 text-[12px] text-text-3">
              <li className="min-w-0">
                <Link href={`/${tenant.slug}`} className="truncate hover:text-text-2">
                  {tenant.name}
                </Link>
              </li>
              <li aria-hidden="true">
                <ChevronRight className="h-3 w-3" />
              </li>
              <li aria-current="page" className="truncate text-text-2">
                {title}
              </li>
            </ol>
          </nav>
          <h1 className="truncate text-[22px] font-semibold leading-tight text-text">{title}</h1>
        </div>

        {/*
          Shrinkable and wrapping, deliberately. A `shrink-0` row of controls
          takes its max-content width and pushes the page sideways; this one
          gives way and wraps onto its own line instead. No screen in this
          product scrolls horizontally.
        */}
        <div className="flex min-w-0 basis-full flex-wrap items-center justify-start gap-2 print-hidden md:basis-auto md:justify-end">
          {children}

          <div className="w-9">
            <UserMenu viewer={viewer} tenant={tenant} collapsed align="down" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The slim row under the title: the account director's one-line interpretation
 * where there is one, and the link that opens the drawer holding every
 * methodology note on the screen.
 *
 * One line. Spec v2 §2 will not have a paragraph on a dashboard screen, and the
 * interpretation is the one sentence a human is allowed to add.
 */
export function PageMeta({
  interpretation,
  children,
}: {
  interpretation?: string | null;
  children?: React.ReactNode;
}) {
  if (!interpretation && !children) return null;
  return (
    <div className="-mt-2 mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      {interpretation ? (
        <p className="min-w-0 text-[13px] italic text-text-2">{interpretation}</p>
      ) : (
        <span />
      )}
      {children}
    </div>
  );
}
