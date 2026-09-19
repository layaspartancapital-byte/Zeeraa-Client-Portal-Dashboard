'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  Building2,
  ChevronsLeft,
  ChevronsRight,
  ClipboardCheck,
  Filter,
  KanbanSquare,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Plug,
  Scale,
  Share2,
  TrendingUp,
  X,
} from 'lucide-react';
import { canAdministerTenant, canSwitchTenant, isZeeraaRole, ROLE_LABELS } from '@zeeraa/core';
import type { TenantSummary, Viewer } from '@/lib/tenant';
import { useShell } from '@/components/shell/shell-state';

/**
 * The fixed left rail (spec v2 §3).
 *
 * 240px, collapsible to 64px icon-only, off-canvas below the `lg` breakpoint so
 * a phone keeps its whole width for the numbers. Tenant identity sits at the
 * top — the accent stripe, the mark and the name — and is never behind a menu:
 * Zeeraa staff sit with two competing lenders open in adjacent tabs, and
 * misreading one for the other is the worst thing this application can do.
 */

const GROUPS: {
  label: string;
  items: {
    segment: string;
    label: string;
    icon: typeof LayoutDashboard;
    adminOnly?: boolean;
  }[];
}[] = [
  {
    label: 'Overview',
    items: [{ segment: '', label: 'Executive', icon: LayoutDashboard }],
  },
  {
    label: 'Performance',
    items: [
      { segment: 'performance', label: 'Monthly performance', icon: TrendingUp },
      { segment: 'funnel', label: 'Funnel', icon: Filter },
    ],
  },
  // Platforms is spliced in below, between Performance and Delivery: its items
  // are the channels this client has actually connected, which is data rather
  // than a constant.
  {
    label: 'Delivery',
    items: [
      { segment: 'delivery', label: 'Delivery', icon: ClipboardCheck },
      { segment: 'workspace', label: 'Workspace', icon: KanbanSquare },
    ],
  },
  {
    label: 'Setup',
    items: [
      { segment: 'connections', label: 'Connections', icon: Plug, adminOnly: true },
      { segment: 'admin', label: 'Reconciliation', icon: Scale, adminOnly: true },
    ],
  },
];

/**
 * A line icon per ad platform, from the same family as the rest of the rail.
 * Not vendor logos: this product does not ship other companies' marks.
 */
const PLATFORM_ICONS: Record<string, typeof LayoutDashboard> = {
  google_ads: Megaphone,
  microsoft_ads: Megaphone,
  meta: Share2,
  linkedin_ads: Share2,
};

export function Sidebar({
  viewer,
  tenant,
  platforms = [],
}: {
  viewer: Viewer;
  tenant: TenantSummary;
  /**
   * Channels this client has actually connected, in a stable order.
   *
   * Passed in rather than listed here: a page exists only for a platform that
   * reports, and a rail advertising Microsoft Ads to a client who has never
   * connected it is a promise the product has not made.
   */
  platforms?: { key: string; label: string }[];
}) {
  const { collapsed, setCollapsed, drawerOpen, setDrawerOpen } = useShell();
  const pathname = usePathname();

  const withPlatforms =
    platforms.length === 0
      ? GROUPS
      : [
          ...GROUPS.slice(0, 2),
          {
            label: 'Platforms',
            items: platforms.map((p) => ({
              segment: `platforms/${p.key}`,
              label: p.label,
              icon: PLATFORM_ICONS[p.key] ?? Megaphone,
            })),
          },
          ...GROUPS.slice(2),
        ];

  // Client roles never see Setup at all — not the items and not the heading,
  // which would otherwise advertise a section they cannot open.
  const groups = withPlatforms
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => !('adminOnly' in item && item.adminOnly) || canAdministerTenant(tenant.role),
      ),
    }))
    .filter((group) => group.items.length > 0);

  const width = collapsed ? 'lg:w-16' : 'lg:w-60';

  return (
    <>
      {drawerOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-40 bg-[rgba(16,24,40,0.35)] lg:hidden"
        />
      )}

      <aside
        data-sidebar
        aria-label="Sections"
        className={`fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-border bg-surface transition-[width,transform] duration-200 lg:translate-x-0 ${width} ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* The tenant's colour, along the top of the rail. */}
        <div
          aria-hidden="true"
          className="h-[3px] shrink-0"
          style={{ background: tenant.accentColor }}
        />

        <div className="flex items-start gap-2.5 px-4 py-4">
          <TenantMark tenant={tenant} />
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold leading-tight text-text">
                {tenant.name}
              </p>
              <p className="truncate text-[12px] text-text-2">
                {ROLE_LABELS[tenant.role]}
                {isZeeraaRole(tenant.role) ? ' · Zeeraa' : ''}
              </p>
            </div>
          )}
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close navigation"
            className="-mr-1 inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-text-2 hover:bg-canvas lg:hidden"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          {groups.map((group) => (
            <div key={group.label} className="mb-3">
              {!collapsed && (
                <p className="px-2 pb-1 text-[12px] font-semibold text-text-3">{group.label}</p>
              )}
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const href = item.segment
                    ? `/${tenant.slug}/${item.segment}`
                    : `/${tenant.slug}`;
                  const active = item.segment
                    ? pathname.startsWith(href)
                    : pathname === `/${tenant.slug}` || pathname === `/${tenant.slug}/`;
                  const Icon = item.icon;

                  return (
                    <li key={item.segment || 'executive'}>
                      <Link
                        href={href}
                        onClick={() => setDrawerOpen(false)}
                        aria-current={active ? 'page' : undefined}
                        title={collapsed ? item.label : undefined}
                        className={`relative flex items-center gap-2.5 rounded-[8px] px-2 py-2 text-[13px] font-medium transition-colors ${
                          active
                            ? 'bg-primary-100 text-primary-600'
                            : 'text-text-2 hover:bg-canvas hover:text-text'
                        } ${collapsed ? 'lg:justify-center' : ''}`}
                      >
                        {active && (
                          <span
                            aria-hidden="true"
                            className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary"
                          />
                        )}
                        <Icon aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                        <span className={collapsed ? 'lg:hidden' : ''}>{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-border p-2">
          <UserMenu viewer={viewer} tenant={tenant} collapsed={collapsed} />
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            className={`mt-1 hidden w-full items-center gap-2.5 rounded-[8px] px-2 py-2 text-[13px] font-medium text-text-2 transition-colors hover:bg-canvas hover:text-text lg:flex ${
              collapsed ? 'justify-center' : ''
            }`}
          >
            {collapsed ? (
              <ChevronsRight aria-hidden="true" className="h-4 w-4" />
            ) : (
              <ChevronsLeft aria-hidden="true" className="h-4 w-4" />
            )}
            {!collapsed && 'Collapse'}
          </button>
        </div>
      </aside>
    </>
  );
}

/** The tenant's mark: its initials on its own accent colour. */
export function TenantMark({
  tenant,
  size = 32,
}: {
  tenant: TenantSummary;
  size?: number;
}) {
  const initials = tenant.name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-[8px] font-semibold text-white"
      style={{
        background: tenant.accentColor,
        width: size,
        height: size,
        fontSize: size * 0.4,
      }}
    >
      {initials}
    </span>
  );
}

/**
 * The signed-in person, and the two things they can do about it.
 *
 * Switching client stays a two-action affordance — open, then select — and is
 * absent entirely for client roles. There is no hover-to-switch and no keyboard
 * shortcut: nothing that can move you to another client's numbers without you
 * having decided to.
 */
export function UserMenu({
  viewer,
  tenant,
  collapsed = false,
  align = 'up',
}: {
  viewer: Viewer;
  tenant: TenantSummary;
  collapsed?: boolean;
  align?: 'up' | 'down';
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const showSwitcher = canSwitchTenant(tenant.role);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const initial = (viewer.name ?? viewer.email).trim()[0]?.toUpperCase() ?? '?';

  return (
    <div ref={wrap} className="relative print-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`flex w-full items-center gap-2.5 rounded-[8px] px-2 py-2 text-left transition-colors hover:bg-canvas ${
          collapsed ? 'lg:justify-center' : ''
        }`}
      >
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-100 text-[12px] font-semibold text-primary-600"
        >
          {initial}
        </span>
        {!collapsed && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-text">
              {viewer.name ?? viewer.email}
            </span>
            <span className="block truncate text-[12px] text-text-3">{viewer.email}</span>
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute left-0 z-50 w-[min(17rem,calc(100vw-2rem))] overflow-hidden rounded-[8px] border border-border bg-surface shadow-[var(--shadow-pop)] ${
            align === 'up' ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]'
          }`}
        >
          {showSwitcher && (
            <>
              <p className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-[12px] font-semibold text-text-3">
                <Building2 aria-hidden="true" className="h-3.5 w-3.5" />
                Switch client
              </p>
              <ul className="max-h-64 overflow-y-auto">
                {viewer.tenants.map((option) => (
                  <li key={option.id}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOpen(false);
                        if (option.id !== tenant.id) router.push(`/${option.slug}`);
                      }}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-canvas"
                    >
                      <span
                        aria-hidden="true"
                        className="h-5 w-[3px] shrink-0 rounded-full"
                        style={{ background: option.accentColor }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-text">{option.name}</span>
                        <span className="block truncate text-[12px] text-text-3 tabular">
                          {option.timezone} · {option.currency}
                        </span>
                      </span>
                      {option.id === tenant.id && (
                        <span className="text-[12px] text-text-3">Current</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <Link
            href="/signout"
            role="menuitem"
            className="flex items-center gap-2 border-t border-border px-3 py-2.5 text-[13px] text-text-2 hover:bg-canvas hover:text-text"
          >
            <LogOut aria-hidden="true" className="h-3.5 w-3.5" />
            Sign out
          </Link>
        </div>
      )}
    </div>
  );
}
