'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';

/**
 * The ⓘ that carries everything the old screens said in paragraphs.
 *
 * Spec v2 §2: a methodology note, a caveat, a definition or a reason something
 * is not measured lives here, in at most two sentences, or in the "How this is
 * measured" drawer. Nothing explains itself inline any more.
 *
 * It opens on hover and on focus, closes on Escape and on blur, and the
 * tooltip is wired to the trigger with `aria-describedby`, so the content is
 * reachable by keyboard and by a screen reader rather than being a hover
 * affordance only.
 */
export function InfoTip({
  children,
  label = 'More information',
  align = 'center',
  className = '',
}: {
  children: React.ReactNode;
  label?: string;
  align?: 'center' | 'start' | 'end';
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <span
      ref={wrap}
      className={`relative inline-flex print-hidden ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-text-3 transition-colors hover:text-primary"
      >
        <Info aria-hidden="true" className="h-[14px] w-[14px]" strokeWidth={2} />
      </button>

      {open && (
        <span
          role="tooltip"
          id={id}
          className={`absolute bottom-[calc(100%+6px)] z-50 w-[min(19rem,calc(100vw-2.5rem))] rounded-[8px] border border-border bg-surface px-3 py-2 text-left text-[12px] font-normal leading-relaxed text-text-2 shadow-[var(--shadow-pop)] ${
            align === 'end'
              ? 'right-0'
              : align === 'start'
                ? 'left-0'
                : 'left-1/2 -translate-x-1/2'
          }`}
        >
          {children}
        </span>
      )}
    </span>
  );
}
