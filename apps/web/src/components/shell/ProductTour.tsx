'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';
import { STEPS } from '@/components/shell/tour-steps';

/**
 * The first-login product tour: the screen dimmed, one element lit at a time,
 * and a caption with Back, Next, Skip and a step counter.
 *
 * It moves between pages on its own, which is why it lives in the tenant
 * layout (through `AppShell`) rather than on a page: the layout survives a
 * client navigation, so the tour's place survives it too. Each step names the
 * page it belongs to and the element it lights, by `data-tour`; a step whose
 * element never appears — a card a role cannot see, a page that fails — is
 * skipped and the counter closes up, rather than lighting nothing.
 *
 * Completion is stored per user in the database (`lib/tour.ts`), so finishing
 * or skipping on one device ends it on every device. "Take the tour" in the
 * avatar menu replays it.
 *
 * Accessible by construction: the caption is a modal dialog that keeps focus
 * inside it, ← and → move, Esc skips, focus returns where it was when the tour
 * ends, and reduced motion gets no movement at all — no easing on the
 * spotlight, no smooth scrolling.
 */

/** How long a step waits for its page and element before it is skipped. */
const FIND_TIMEOUT_MS = 12_000;
/** Room around the lit element, so its border is not cut by the dimming. */
const PAD = 6;

type TourApi = { start: () => void };
const TourContext = createContext<TourApi | null>(null);

/** `start` for the avatar menu; null outside a tenant, where there is no tour. */
export function useTour(): TourApi | null {
  return useContext(TourContext);
}

export function TourProvider({
  slug,
  autoStart,
  onComplete,
  children,
}: {
  slug: string;
  /** True until this user has finished or skipped this version. */
  autoStart: boolean;
  /** Records completion for this user; a server action. */
  onComplete: () => Promise<void>;
  children: React.ReactNode;
}) {
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(new Set());
  const started = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);

  const start = useCallback(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSkipped(new Set());
    setIndex(0);
    setActive(true);
  }, []);

  // Once per mount, and only while the database says it has not been done.
  useEffect(() => {
    if (autoStart && !started.current) {
      started.current = true;
      start();
    }
  }, [autoStart, start]);

  const finish = useCallback(() => {
    setActive(false);
    started.current = true;
    returnFocus.current?.focus?.();
    onComplete().catch((error) => {
      // The tour returns on the next sign-in; that is the whole cost.
      console.error('[tour] could not record completion', error);
    });
  }, [onComplete]);

  return (
    <TourContext.Provider value={{ start }}>
      {children}
      {active && (
        <Tour
          slug={slug}
          index={index}
          setIndex={setIndex}
          skipped={skipped}
          skip={(i) => setSkipped((s) => new Set([...s, i]))}
          finish={finish}
        />
      )}
    </TourContext.Provider>
  );
}

function Tour({
  slug,
  index,
  setIndex,
  skipped,
  skip,
  finish,
}: {
  slug: string;
  index: number;
  setIndex: (i: number) => void;
  skipped: ReadonlySet<number>;
  skip: (i: number) => void;
  finish: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const reduced = usePrefersReducedMotion();
  const [rect, setRect] = useState<Rect | null>(null);
  const [mounted, setMounted] = useState(false);
  const direction = useRef<1 | -1>(1);
  const dialog = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);

  const step = STEPS[index]!;
  const visible = STEPS.map((_, i) => i).filter((i) => !skipped.has(i));
  const position = visible.indexOf(index) + 1;
  const isFirst = visible[0] === index;
  const isLast = visible.at(-1) === index;

  useEffect(() => setMounted(true), []);

  const go = useCallback(
    (to: 1 | -1) => {
      direction.current = to;
      let next = index + to;
      while (next >= 0 && next < STEPS.length && skipped.has(next)) next += to;
      if (next >= STEPS.length) return finish();
      if (next < 0) return;
      setIndex(next);
    },
    [index, skipped, setIndex, finish],
  );

  // Take the tour to the step's page, then wait for its element.
  useEffect(() => {
    setRect(null);
    const href = `/${slug}${step.path}`;
    if (pathname !== href) router.push(href);

    const deadline = Date.now() + FIND_TIMEOUT_MS;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const find = () => {
      const el = pathname === href ? findTarget(step.target) : null;
      if (el) {
        placeInView(el, reduced);
        const track = () => {
          setRect((prev) => sameRect(prev, el.getBoundingClientRect()));
          frame = requestAnimationFrame(track);
        };
        track();
        return;
      }
      if (Date.now() > deadline) {
        // Never light nothing: close up the counter and carry on the way the
        // reader was going. Backing past the first step turns forward.
        skip(index);
        let next = index + direction.current;
        while (next >= 0 && next < STEPS.length && skipped.has(next)) next += direction.current;
        if (next < 0) next = index + 1;
        if (next >= STEPS.length) finish();
        else setIndex(next);
        return;
      }
      timer = setTimeout(find, 100);
    };
    find();
    return () => {
      cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
    };
    // `skipped` is read for the skip path only and deliberately not a
    // dependency: re-running on it would restart the search for the step it
    // just added.
  }, [index, pathname, slug, reduced]);

  // Focus into the caption on every step, so a screen reader reads it.
  useEffect(() => {
    primary.current?.focus({ preventScroll: true });
  }, [index, rect === null]);

  // ← → move, Esc skips, and Tab stays inside the caption.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        go(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        go(-1);
      } else if (e.key === 'Tab' && dialog.current) {
        const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled])')];
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items.at(-1)!;
        const inside = dialog.current.contains(document.activeElement);
        if (e.shiftKey && (document.activeElement === first || !inside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [go, finish]);

  if (!mounted) return null;

  const lit = rect && {
    top: rect.top - PAD,
    left: rect.left - PAD,
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2,
  };
  const motion = reduced ? '' : 'transition-[top,left,width,height] duration-200 ease-out';

  return createPortal(
    <div className="print-hidden">
      {/* Catches every click: nothing behind the tour is live while it runs. */}
      <div className="fixed inset-0 z-[80]" aria-hidden="true" />
      {lit ? (
        <div
          aria-hidden="true"
          className={`pointer-events-none fixed z-[81] rounded-[14px] ring-2 ring-white/80 ${motion}`}
          style={{ ...lit, boxShadow: '0 0 0 9999px rgba(16, 24, 40, 0.62)' }}
        />
      ) : (
        <div aria-hidden="true" className="fixed inset-0 z-[81] bg-[rgba(16,24,40,0.62)]" />
      )}

      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-caption"
        className="fixed inset-x-4 bottom-4 z-[82] rounded-[12px] bg-surface p-4 shadow-[var(--shadow-pop)] sm:inset-x-auto sm:bottom-auto sm:w-[22rem]"
        style={captionPlacement(lit)}
      >
        <p className="text-[12px] font-medium tabular text-text-3" aria-live="polite">
          {position} of {visible.length}
        </p>
        <h2 id="tour-title" className="mt-1 text-[15px] font-semibold text-text">
          {step.title}
        </h2>
        <p id="tour-caption" className="mt-1 text-[14px] leading-snug text-text-2">
          {step.caption}
        </p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={finish}
            className="rounded-[8px] px-2 py-1.5 text-[13px] text-text-2 underline underline-offset-2 hover:text-text"
          >
            Skip tour
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => go(-1)}
              disabled={isFirst}
              className="h-9 rounded-[8px] border border-border px-3 text-[13px] font-medium text-text disabled:opacity-40"
            >
              Back
            </button>
            <button
              ref={primary}
              type="button"
              onClick={() => go(1)}
              className="h-9 rounded-[8px] bg-primary px-3 text-[13px] font-semibold text-white"
            >
              {isLast ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type Rect = { top: number; left: number; width: number; height: number };

function findTarget(name: string): HTMLElement | null {
  // The first one with a box: a phone and a desktop layout can both be in the
  // document, and a hidden one measures zero.
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

/** Only a new object when the box moved, so the tracking loop does not re-render every frame. */
function sameRect(prev: Rect | null, r: DOMRect): Rect {
  if (prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height) {
    return prev;
  }
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/**
 * Scroll the element to just under the sticky top bar. Not `scrollIntoView`:
 * `center` puts a tall card under the bar, and on a phone the caption sits
 * over the bottom third of the screen.
 */
function placeInView(el: HTMLElement, reduced: boolean) {
  const bar = document.querySelector<HTMLElement>('[data-topbar]');
  if (bar?.contains(el)) {
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    return;
  }
  const offset = (bar?.getBoundingClientRect().height ?? 0) + 16;
  const top = el.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top: Math.max(0, top), behavior: reduced ? 'auto' : 'smooth' });
}

/**
 * Beside the lit element on a wide screen — below it where there is room,
 * above it where there is not. On a phone the stylesheet docks it to the
 * bottom edge and this returns nothing.
 */
function captionPlacement(lit: Rect | null): React.CSSProperties | undefined {
  if (typeof window === 'undefined' || window.innerWidth < 640 || !lit) return undefined;
  const width = 352;
  const gap = 12;
  const left = Math.min(Math.max(16, lit.left), window.innerWidth - width - 16);
  const below = lit.top + lit.height + gap;
  const room = window.innerHeight - below;
  if (room >= 200) return { top: below, left };
  const above = lit.top - gap - 200;
  if (above >= 16) return { top: above, left };
  // Taller than the screen: pin to the bottom corner, over the element.
  return { bottom: 16, right: 16 };
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
