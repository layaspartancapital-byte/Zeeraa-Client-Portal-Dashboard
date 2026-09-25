'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  BarChart3,
  Building2,
  ChevronsLeft,
  ChevronsRight,
  Filter,
  LayoutDashboard,
  LogOut,
  Megaphone,
  MousePointerClick,
  Plug,
  Scale,
  Search,
  Users,
  Share2,
  Briefcase,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  canAdministerTenant,
  canManageUsers,
  canSwitchTenant,
  ROLE_LABELS,
  type Role,
} from '@zeeraa/core';
import type { TenantSummary, Viewer } from '@/lib/tenant';
import { useShell } from '@/components/shell/shell-state';
import { ZeeraaMark } from '@/components/shell/ZeeraaMark';

/**
 * The fixed left rail (spec v2 §3, as amended by the rebrand).
 *
 * 240px, collapsible to 64px icon-only, off-canvas below the `lg` breakpoint so
 * a phone keeps its whole width for the numbers.
 *
 * **Near-black, and it carries two identities in a fixed order.** Zeeraa is the
 * platform and sits at the top; the client is the tenant and sits beneath a
 * hairline. Reading order gives the hierarchy, so neither has to be subordinate
 * in colour — which matters because the tenant's identity is never behind a
 * menu: Zeeraa staff sit with two competing lenders open in adjacent tabs, and
 * misreading one for the other is the worst thing this application can do.
 *
 * Gold marks the active item and nothing else in here.
 */

/**
 * A per-item permission rather than one `adminOnly` flag.
 *
 * People is open to both admin roles and Reconciliation is not, so a single
 * boolean cannot express the rail any more. The predicate is the same function
 * the page guards itself with, so a link and the screen it opens can never
 * disagree about who may see it.
 */
type NavGroup = {
  label: string;
  items: {
    segment: string;
    label: string;
    icon: typeof LayoutDashboard;
    permitted?: (role: Role) => boolean;
  }[];
};

const GROUPS: NavGroup[] = [
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
  // Platforms is spliced in below, between Performance and Setup: its items
  // are the channels this client has actually connected, which is data rather
  // than a constant.
  {
    label: 'Setup',
    items: [
      { segment: 'people', label: 'People', icon: Users, permitted: canManageUsers },
      { segment: 'connections', label: 'Connections', icon: Plug, permitted: canAdministerTenant },
      { segment: 'admin', label: 'Reconciliation', icon: Scale, permitted: canAdministerTenant },
    ],
  },
];

/**
 * A line icon per platform, from the same family as the rest of the rail, and
 * a different one for each: collapsed, the icon is all that tells two
 * platform pages apart (they all drew a megaphone until 25 September 2026).
 * Not vendor logos: this product does not ship other companies' marks. A
 * platform with no entry shows its initial instead (`PlatformInitial`).
 */
const PLATFORM_ICONS: Record<string, typeof LayoutDashboard> = {
  google_ads: Megaphone,
  meta: Share2,
  ga4: BarChart3,
  search_console: Search,
  microsoft_ads: MousePointerClick,
  linkedin_ads: Briefcase,
};

/** A platform's initial in the icon's 16px box, for a platform with no icon. */
function platformInitial(label: string): typeof LayoutDashboard {
  const letter = label.trim()[0]?.toUpperCase() ?? '?';
  function PlatformInitial({ className }: { className?: string }) {
    return (
      <span
        aria-hidden="true"
        className={`${className ?? ''} inline-flex items-center justify-center rounded-[4px] ring-1 ring-inset ring-current text-[10px] font-semibold leading-none`}
      >
        {letter}
      </span>
    );
  }
  return PlatformInitial as unknown as typeof LayoutDashboard;
}

/**
 * The page name beside a collapsed rail item, on hover and on keyboard focus.
 *
 * Portalled and fixed rather than absolutely placed: the nav scrolls, and an
 * overflow container clips anything that sticks out of it. Shown only while
 * the rail is collapsed at `lg` and up — below that the rail is a drawer with
 * its labels visible, and a tooltip would repeat one.
 */
function RailTip({ label, enabled, children }: { label: string; enabled: boolean; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!enabled) setAt(null);
  }, [enabled]);
  const show = () => {
    if (!enabled || !ref.current || !window.matchMedia('(min-width: 1024px)').matches) return;
    const r = ref.current.getBoundingClientRect();
    setAt({ top: r.top + r.height / 2, left: r.right + 8 });
  };
  const hide = () => setAt(null);
  return (
    <span
      ref={ref}
      className="block"
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(e) => e.key === 'Escape' && hide()}
    >
      {children}
      {at &&
        createPortal(
          <span
            role="tooltip"
            className="pointer-events-none fixed z-[70] -translate-y-1/2 whitespace-nowrap rounded-[6px] bg-chrome-raised px-2 py-1 text-[12px] font-medium text-on-chrome shadow-[var(--shadow-pop)] ring-1 ring-chrome-border"
            style={{ top: at.top, left: at.left }}
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}

export function Sidebar({
  viewer,
  tenant,
  platforms = [],
  logo = null,
  mark = null,
}: {
  viewer: Viewer;
  tenant: TenantSummary;
  /** The tenant's own logo; null falls back to its initials. */
  logo?: string | null;
  /** The tenant's square mark for the collapsed rail; null shows a monogram. */
  mark?: string | null;
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

  const withPlatforms: NavGroup[] =
    platforms.length === 0
      ? GROUPS
      : [
          ...GROUPS.slice(0, 2),
          {
            label: 'Platforms',
            items: platforms.map((p) => ({
              segment: `platforms/${p.key}`,
              label: p.label,
              icon: PLATFORM_ICONS[p.key] ?? platformInitial(p.label),
            })),
          },
          ...GROUPS.slice(2),
        ];

  // A group whose every item is filtered away loses its heading too, which
  // would otherwise advertise a section with nothing in it. A client viewer
  // sees no Setup heading at all; a client admin sees it with People alone.
  const groups = withPlatforms
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.permitted || item.permitted(tenant.role)),
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
        className={`fixed inset-y-0 left-0 z-50 flex w-60 flex-col bg-chrome transition-[width,transform] duration-200 lg:translate-x-0 ${width} ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Zeeraa: the platform, and the roof over every tenant below it. */}
        <div
          className={`flex h-16 shrink-0 items-center ${collapsed ? 'lg:justify-center lg:px-0' : ''} px-4`}
        >
          <Link href={`/${tenant.slug}`} aria-label="Zeeraa home" className="inline-flex">
            {collapsed ? (
              <>
                <span className="hidden lg:block">
                  <ZeeraaMark height={32} variant="mark" />
                </span>
                <span className="lg:hidden">
                  <ZeeraaMark height={34} variant="lockup" />
                </span>
              </>
            ) : (
              <ZeeraaMark height={34} variant="lockup" />
            )}
          </Link>
        </div>

        {/*
          The client, under a hairline. The rule is doing the work the old
          accent stripe did — saying where the platform ends and this
          engagement begins — without sitting above the wordmark as a stray
          line through the logo.
        */}
        <div
          className={`flex items-start gap-2.5 border-y border-chrome-border px-4 py-3 ${
            collapsed ? 'lg:justify-center lg:px-0' : ''
          }`}
        >
          {/*
            Collapsed to 64px, the tenant is one square: its stored mark
            (cropped from its own logo, migration 0038) or a monogram in the
            rail's own materials. Expanded, the logo is a wordmark shown as the
            tenant drew it — the one live logo is white type for dark grounds,
            and at 5:1 it cannot live in a square — or, with none, the name.
          */}
          {collapsed && (
            <span className="hidden lg:block">
              <RailTip label={tenant.name} enabled={collapsed}>
                <TenantSquare tenant={tenant} mark={mark} />
              </RailTip>
            </span>
          )}
          <div className={`flex min-w-0 flex-1 items-start gap-2.5 ${collapsed ? 'lg:hidden' : ''}`}>
            {!logo && <TenantMark tenant={tenant} onChrome />}
            <div className="min-w-0 flex-1">
              {logo ? (
                /* A data URL from the tenant row; next/image has nothing to optimise. */
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={logo}
                  alt={tenant.name}
                  className="mb-1 block h-8 w-auto max-w-full object-contain object-left"
                />
              ) : (
                <p className="truncate text-[14px] font-semibold leading-tight text-on-chrome">
                  {tenant.name}
                </p>
              )}
              {/*
                The role alone. It used to carry a ` · Zeeraa` suffix, which
                said which side of the engagement the reader is on — and the
                wordmark two rows above now says that, so the suffix rendered as
                "Zeeraa admin · Zeeraa".
              */}
              <p className="truncate text-[12px] text-on-chrome-2">{ROLE_LABELS[tenant.role]}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close navigation"
            className="-mr-1 inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-on-chrome-2 hover:bg-chrome-raised hover:text-on-chrome lg:hidden"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          {groups.map((group) => (
            <div key={group.label} className="mb-3">
              {/* `lg:hidden` rather than unmounted: below `lg` the rail is a
                  drawer at full width, whatever the desktop rail was left as. */}
              <p
                className={`px-2 pb-1 text-[12px] font-semibold text-on-chrome-3 ${collapsed ? 'lg:hidden' : ''}`}
              >
                {group.label}
              </p>
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
                      <RailTip label={item.label} enabled={collapsed}>
                      <Link
                        href={href}
                        onClick={() => setDrawerOpen(false)}
                        aria-current={active ? 'page' : undefined}
                        aria-label={item.label}
                        className={`relative flex items-center gap-2.5 rounded-[8px] px-2 py-2 text-[13px] font-medium transition-colors ${
                          active
                            ? 'bg-gold-wash text-gold'
                            : 'text-on-chrome-2 hover:bg-chrome-raised hover:text-on-chrome'
                        } ${collapsed ? 'lg:justify-center' : ''}`}
                      >
                        {active && (
                          <span
                            aria-hidden="true"
                            className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-gold"
                          />
                        )}
                        <Icon aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                        <span className={collapsed ? 'lg:hidden' : ''}>{item.label}</span>
                      </Link>
                      </RailTip>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-chrome-border p-2">
          <UserMenu viewer={viewer} tenant={tenant} collapsed={collapsed} />
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            className={`mt-1 hidden w-full items-center gap-2.5 rounded-[8px] px-2 py-2 text-[13px] font-medium text-on-chrome-2 transition-colors hover:bg-chrome-raised hover:text-on-chrome lg:flex ${
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

/**
 * The tenant in the collapsed rail: its stored square mark, or a monogram.
 *
 * The monogram is the rail's own materials — raised chrome, a hairline, type
 * in `on-chrome` — with the tenant's accent as a 2px rule along its foot, so
 * two lenders in adjacent tabs still differ at a glance. The accent-filled
 * square it replaced put Spartan's `#2F5D8C` under white type on near-black,
 * and read as a sticker on the rail rather than part of it.
 */
function TenantSquare({ tenant, mark }: { tenant: TenantSummary; mark: string | null }) {
  if (mark) {
    return (
      <span className="flex h-8 w-8 items-center justify-center" role="img" aria-label={tenant.name}>
        {/* A data URL from the tenant row; next/image has nothing to optimise. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={mark} alt="" className="block h-7 w-7 object-contain" />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={tenant.name}
      className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-chrome-raised text-[12px] font-semibold tracking-[0.02em] text-on-chrome ring-1 ring-inset ring-chrome-border"
      style={{ boxShadow: `inset 0 -2px 0 0 ${tenant.accentColor}` }}
    >
      {initialsOf(tenant.name)}
    </span>
  );
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * The tenant's initials on its own accent colour — the expanded rail's
 * fallback where no logo is stored.
 *
 * `onChrome` adds a hairline ring, and it is not decoration. A tenant's accent
 * is arbitrary and some of them are dark: Spartan's `#2F5D8C` is 2.64:1 against
 * the near-black rail, under the 3:1 a graphical object needs, so the square
 * would read as a hole rather than a mark. The ring gives it a boundary that
 * clears 3:1 whatever colour is behind it, which fixes every tenant at once
 * rather than asking each of them to re-pick.
 */
export function TenantMark({
  tenant,
  size = 32,
  onChrome = false,
}: {
  tenant: TenantSummary;
  size?: number;
  onChrome?: boolean;
}) {

  const initials = initialsOf(tenant.name);

  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-[8px] font-semibold text-white ${
        onChrome ? 'ring-1 ring-inset ring-on-chrome-3/60' : ''
      }`}
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
 *
 * Two placements. In the rail the trigger sits on chrome and the panel opens
 * upward from its left edge. In the top bar the trigger is on the light canvas
 * at the right-hand end of the screen, so the panel opens downward and is
 * anchored to the trigger's *right* edge: anchored left, as it once was, a
 * 17rem panel from an avatar 16px from the edge runs off the screen at every
 * width. Its width is capped at the viewport less both gutters, so it stays
 * inside the screen at 390px too.
 *
 * The panel stays light either way. A list of client names is content, and it
 * is read at the moment somebody is deciding which client to look at.
 */
export function UserMenu({
  viewer,
  tenant,
  collapsed = false,
  placement = 'rail',
}: {
  viewer: Viewer;
  tenant: TenantSummary;
  collapsed?: boolean;
  placement?: 'rail' | 'topbar';
}) {
  const inTopbar = placement === 'topbar';
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
        aria-label={inTopbar ? `Account: ${viewer.name ?? viewer.email}` : undefined}
        className={
          inTopbar
            ? 'flex items-center rounded-full p-0.5 transition-colors hover:bg-surface'
            : `flex w-full items-center gap-2.5 rounded-[8px] px-2 py-2 text-left transition-colors hover:bg-chrome-raised ${
                collapsed ? 'lg:justify-center' : ''
              }`
        }
      >
        <span
          aria-hidden="true"
          className={`flex shrink-0 items-center justify-center rounded-full font-semibold ${
            inTopbar
              ? 'h-8 w-8 bg-primary text-[13px] text-white'
              : 'h-7 w-7 bg-primary-100 text-[12px] text-primary'
          }`}
        >
          {initial}
        </span>
        {!inTopbar && (
          <span className={`min-w-0 flex-1 ${collapsed ? 'lg:hidden' : ''}`}>
            <span className="block truncate text-[13px] font-medium text-on-chrome">
              {viewer.name ?? viewer.email}
            </span>
            <span className="block truncate text-[12px] text-on-chrome-3">{viewer.email}</span>
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute z-50 w-[min(17rem,calc(100vw-2rem))] overflow-hidden rounded-[8px] border border-border bg-surface shadow-[var(--shadow-pop)] ${
            inTopbar ? 'right-0 top-[calc(100%+6px)]' : 'left-0 bottom-[calc(100%+6px)]'
          }`}
        >
          {inTopbar && (
            <div className="border-b border-border px-3 py-2">
              <p className="truncate text-[13px] font-medium text-text">
                {viewer.name ?? viewer.email}
              </p>
              <p className="truncate text-[12px] text-text-3">{viewer.email}</p>
            </div>
          )}
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
