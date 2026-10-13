'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock3, Info } from 'lucide-react';

/** Gap between the icon and the bubble, and the least distance to a viewport edge. */
const GAP = 6;
const EDGE = 8;

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
 *
 * The bubble renders in a portal on `document.body`, fixed against the icon's
 * rect: an ⓘ in a table header sits inside the card's horizontal scroll
 * container, which clipped an absolutely positioned bubble (13 October 2026).
 * It follows any scroll — the page's or the table's — and the viewport size,
 * stays inside the viewport, and opens below the icon when there is no room
 * above.
 */
export function InfoTip({
  children,
  label = 'More information',
  align = 'center',
  className = '',
  icon = 'info',
}: {
  children: React.ReactNode;
  label?: string;
  align?: 'center' | 'start' | 'end';
  className?: string;
  /** `clock` for a note about time — "recent days may still update". */
  icon?: 'info' | 'clock';
}) {
  const Icon = icon === 'clock' ? Clock3 : Info;
  const id = useId();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const position = useCallback(() => {
    const trigger = wrap.current?.getBoundingClientRect();
    const tip = bubble.current?.getBoundingClientRect();
    if (!trigger || !tip) return;
    const viewport = document.documentElement.clientWidth;
    const wanted =
      align === 'end'
        ? trigger.right - tip.width
        : align === 'start'
          ? trigger.left
          : trigger.left + trigger.width / 2 - tip.width / 2;
    const left = Math.min(Math.max(wanted, EDGE), Math.max(EDGE, viewport - tip.width - EDGE));
    const above = trigger.top - GAP - tip.height;
    const top = above >= EDGE ? above : trigger.bottom + GAP;
    setPlace((p) => (p && p.left === left && p.top === top ? p : { left, top }));
  }, [align]);

  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    position();
    // Capture, so a scroll inside a table's own container moves the bubble too.
    window.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    return () => {
      window.removeEventListener('scroll', position, true);
      window.removeEventListener('resize', position);
    };
  }, [open, position]);

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
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-text-3 transition-colors hover:text-text"
      >
        <Icon aria-hidden="true" className="h-[14px] w-[14px]" strokeWidth={2} />
      </button>

      {open &&
        createPortal(
          <span
            ref={bubble}
            role="tooltip"
            id={id}
            style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: 'hidden' }}
            className="pointer-events-none fixed z-[70] w-[min(19rem,calc(100vw-2.5rem))] rounded-[8px] border border-border bg-surface px-3 py-2 text-left text-[12px] font-normal normal-case leading-relaxed tracking-normal text-text-2 shadow-[var(--shadow-pop)]"
          >
            {children}
          </span>,
          document.body,
        )}
    </span>
  );
}
