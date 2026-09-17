'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TenantSummary } from '@/lib/tenant';

/**
 * Two actions to switch: open, then select.
 *
 * Zeeraa staff sit with two competing lenders open in adjacent tabs, and
 * misreading one for the other is the worst thing this application can do. So
 * there is no hover-to-switch and no keyboard shortcut — nothing that can move
 * you to another client's numbers without you having decided to. Keyboard
 * navigation of the open list works normally; that is a different thing.
 */
export function TenantSwitcher({
  tenants,
  current,
}: {
  tenants: TenantSummary[];
  current: TenantSummary;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    listRef.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function moveFocus(from: HTMLElement, delta: number) {
    const buttons = Array.from(listRef.current?.querySelectorAll('button') ?? []);
    const index = buttons.indexOf(from as HTMLButtonElement);
    buttons[Math.max(0, Math.min(buttons.length - 1, index + delta))]?.focus();
  }

  return (
    <div ref={containerRef} className="relative print-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex items-center gap-2 rounded-[4px] border border-rule bg-surface px-2.5 py-1.5 text-[13px] text-graphite transition-colors hover:text-ink"
      >
        Switch client
        <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true" className="opacity-60">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-[calc(100%+6px)] z-50 w-72 border border-rule bg-surface shadow-[0_8px_24px_rgba(20,22,26,0.10)]">
          <p className="border-b border-rule px-3 py-2 text-[12px] text-graphite">
            {tenants.length} {tenants.length === 1 ? 'client' : 'clients'}
          </p>
          <ul ref={listRef} role="listbox" aria-label="Clients" className="max-h-80 overflow-y-auto">
            {tenants.map((tenant) => {
              const isCurrent = tenant.id === current.id;
              return (
                <li key={tenant.id} role="option" aria-selected={isCurrent}>
                  <button
                    type="button"
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        moveFocus(e.currentTarget, 1);
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        moveFocus(e.currentTarget, -1);
                      }
                    }}
                    onClick={() => {
                      setOpen(false);
                      if (!isCurrent) router.push(`/${tenant.slug}`);
                    }}
                    className="flex w-full items-center gap-2.5 border-b border-rule px-3 py-2.5 text-left last:border-b-0 hover:bg-paper"
                  >
                    <span
                      aria-hidden="true"
                      className="h-6 w-[3px] shrink-0"
                      style={{ background: tenant.accentColor }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">{tenant.name}</span>
                      <span className="block truncate text-[11px] text-graphite">
                        {tenant.timezone} · {tenant.currency}
                      </span>
                    </span>
                    {isCurrent && <span className="text-[11px] text-graphite">Current</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
