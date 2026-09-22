'use client';

import Link from 'next/link';
import { ChevronRight, Menu } from 'lucide-react';
import type { TenantSummary, Viewer } from '@/lib/tenant';
import { useShell } from '@/components/shell/shell-state';
import { UserMenu } from '@/components/shell/Sidebar';

/**
 * The top bar (spec v2 §3, as amended by the rebrand).
 *
 * Rendered by each page rather than by the layout, because it carries that
 * page's title and that page's controls. It sticks to the top of the content
 * column, which is what makes it read as chrome while staying page-aware.
 *
 * **Two bands, and the seam between them is the point.** The title band is
 * near-black and continues the rail, so the chrome reads as one L around the
 * content. The controls sit below it on the light canvas, because a date field
 * and a select are things people operate rather than read, and the light
 * versions of them are the ones this product has already got right. Putting
 * them on near-black would have bought cohesion with a rebuild of every form
 * control in the shell.
 *
 * It wraps below `md`: at 390px the controls cannot share a line with the
 * title, and the alternative is a horizontal scroll, which no screen in this
 * product is allowed to have.
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
    <div data-topbar className="sticky top-0 z-30 -mx-4 mb-6 sm:-mx-6">
      {/*
        Full-bleed to the right of the rail, so the chrome reads as one L.
        The content column is `max-w-[1440px] mx-auto`, so on anything wider the
        band would otherwise stop mid-air with canvas either side of it. The
        overhang is clipped by `overflow-x: clip` on `html` — which is there for
        exactly this and does not make the page scrollable — and the rail is
        `fixed` at a higher layer, so the left overhang never shows.
      */}
      <div className="relative bg-chrome px-4 before:absolute before:inset-y-0 before:-left-[50vw] before:-right-[50vw] before:bg-chrome before:content-[''] sm:px-6">
        <div className="relative flex min-h-16 items-center gap-x-3 py-2.5">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            className="-ml-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] text-on-chrome-2 hover:bg-chrome-raised hover:text-on-chrome lg:hidden"
          >
            <Menu aria-hidden="true" className="h-5 w-5" />
          </button>

          <div className="min-w-0 flex-1">
            <nav aria-label="Breadcrumb">
              <ol className="flex items-center gap-1 text-[12px] text-on-chrome-3">
                <li className="min-w-0">
                  <Link href={`/${tenant.slug}`} className="truncate hover:text-on-chrome-2">
                    {tenant.name}
                  </Link>
                </li>
                <li aria-hidden="true">
                  <ChevronRight className="h-3 w-3" />
                </li>
                <li aria-current="page" className="truncate text-on-chrome-2">
                  {title}
                </li>
              </ol>
            </nav>
            <h1 className="truncate text-[22px] font-semibold leading-tight text-on-chrome">
              {title}
            </h1>
          </div>

          <div className="w-9 shrink-0 print-hidden">
            <UserMenu viewer={viewer} tenant={tenant} collapsed align="down" />
          </div>
        </div>
      </div>

      {/*
        Shrinkable and wrapping, deliberately. A `shrink-0` row of controls
        takes its max-content width and pushes the page sideways; this one gives
        way and wraps onto its own line instead. No screen in this product
        scrolls horizontally.

        Absent entirely when a page has no controls — the briefing is one — so
        an empty strip never appears under the seam.
      */}
      {children && (
        <div className="border-b border-border bg-canvas px-4 py-2.5 sm:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-2 print-hidden md:justify-end">
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
