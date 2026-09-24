'use client';

import Link from 'next/link';
import { ChevronRight, Compass, Menu } from 'lucide-react';
import type { TenantSummary, Viewer } from '@/lib/tenant';
import { useShell } from '@/components/shell/shell-state';
import { UserMenu } from '@/components/shell/Sidebar';
import { useTour } from '@/components/shell/ProductTour';

/**
 * The top bar (spec v2 §3, as amended 23 September 2026).
 *
 * Rendered by each page rather than by the layout, because it carries that
 * page's title and that page's controls. It sticks to the top of the content
 * column.
 *
 * **Light, and the breadcrumb is the title.** It was a near-black band that
 * continued the rail, holding a breadcrumb and an h1 that said the same word
 * twice. The client asked for the band to go: the rail alone now carries the
 * chrome, and this bar sits on the canvas with everything else a person reads.
 * The page name is the breadcrumb's last item, set a size up; the h1 survives
 * for screen readers only, so the page still has a heading to land on.
 *
 * It wraps below `md`: at 390px the controls cannot share a line with the
 * breadcrumb, and the alternative is a horizontal scroll, which no screen in
 * this product is allowed to have.
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
  const tour = useTour();

  return (
    <div
      data-topbar
      className="sticky top-0 z-30 -mx-4 mb-6 border-b border-border bg-canvas/95 backdrop-blur-sm sm:-mx-6"
    >
      <h1 className="sr-only">{title}</h1>
      <div className="flex min-h-14 items-center gap-x-3 px-4 py-2 sm:px-6">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation"
          className="-ml-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] text-text-2 hover:bg-surface hover:text-text lg:hidden print-hidden"
        >
          <Menu aria-hidden="true" className="h-5 w-5" />
        </button>

        <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-1.5">
            {/* The tenant gives way before the page name does: the name is the
                page's title now, and the rail carries the tenant in full. */}
            <li className="min-w-[3.5rem] shrink">
              <Link
                href={`/${tenant.slug}`}
                className="block truncate text-[13px] text-text-3 hover:text-text"
              >
                {tenant.name}
              </Link>
            </li>
            <li aria-hidden="true" className="shrink-0 text-text-3">
              <ChevronRight className="h-3.5 w-3.5" />
            </li>
            <li
              aria-current="page"
              className="min-w-0 shrink-0 basis-auto truncate text-[16px] font-semibold leading-tight text-text [max-width:calc(100%-5rem)]"
            >
              {title}
            </li>
          </ol>
        </nav>

        <div className="flex shrink-0 items-center gap-2 print-hidden">
          {/* Beside the avatar rather than inside its menu: a client who
              skipped the tour on day one will not go looking for it. The
              word hides on a phone, where the breadcrumb needs the room. */}
          {tour && (
            <button
              type="button"
              onClick={tour.start}
              aria-label="Take the tour"
              className="inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-border bg-surface px-2.5 text-[13px] font-medium text-text-2 hover:text-text"
            >
              <Compass aria-hidden="true" className="h-4 w-4" />
              <span className="hidden sm:inline">Take the tour</span>
            </button>
          )}
          <UserMenu viewer={viewer} tenant={tenant} collapsed placement="topbar" />
        </div>
      </div>

      {/*
        Shrinkable and wrapping, deliberately. A `shrink-0` row of controls
        takes its max-content width and pushes the page sideways; this one gives
        way and wraps onto its own line instead.

        Absent entirely when a page has no controls, so an empty strip never
        appears under the breadcrumb.
      */}
      {children && (
        <div className="border-t border-border px-4 py-2.5 sm:px-6">
          <div className="flex min-w-0 flex-wrap items-start gap-2 print-hidden md:justify-end">
            {children}
          </div>
        </div>
      )}
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
