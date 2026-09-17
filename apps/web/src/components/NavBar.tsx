'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { canAdministerTenant, type Role } from '@zeeraa/core';

const SECTIONS = [
  { segment: '', label: 'Executive' },
  { segment: 'performance', label: 'Monthly performance' },
  { segment: 'funnel', label: 'Funnel' },
  { segment: 'delivery', label: 'Delivery' },
  { segment: 'workspace', label: 'Workspace' },
  { segment: 'connections', label: 'Connections', adminOnly: true },
  { segment: 'admin', label: 'Admin', adminOnly: true },
] as const;

/** Labelled navigation. Never an icon-only rail. */
export function NavBar({ slug, role }: { slug: string; role: Role }) {
  const pathname = usePathname();
  const visible = SECTIONS.filter((s) => !('adminOnly' in s && s.adminOnly) || canAdministerTenant(role));

  return (
    <nav aria-label="Sections" className="border-t border-rule">
      <ul className="mx-auto flex max-w-[1400px] gap-1 overflow-x-auto px-2 sm:px-4">
        {visible.map((section) => {
          const href = section.segment ? `/${slug}/${section.segment}` : `/${slug}`;
          const active = section.segment
            ? pathname.startsWith(href)
            : pathname === `/${slug}` || pathname === `/${slug}/`;
          return (
            <li key={section.segment || 'executive'}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`inline-block whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] transition-colors ${
                  active
                    ? 'border-brass text-ink'
                    : 'border-transparent text-graphite hover:text-ink'
                }`}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
