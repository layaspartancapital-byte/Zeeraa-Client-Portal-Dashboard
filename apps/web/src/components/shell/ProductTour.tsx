'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';
import { STEPS } from '@/components/shell/tour-steps';

type PrefetchOptions = NonNullable<Parameters<ReturnType<typeof useRouter>['prefetch']>[1]>;

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
 * ends, and reduced motion gets no easing on the spotlight. Scrolling is always
 * instant: a tour that animates its way to each step is a tour somebody waits
 * through.
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
  const [layout, setLayout] = useState<Layout | null>(null);
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

  /*
   * Every page the tour visits, fetched in full once when it starts, so a step
   * on another page is a client transition from cache rather than a server
   * render the reader waits through — they read a caption or two first, which
   * is far longer than the fetch.
   *
   * `kind: 'full'` is the point. A plain `router.prefetch` of a dynamic page
   * with no `loading.js` fetches the layout only, and the navigation then
   * renders the page on the server anyway (1.6s to Funnel, measured). A full
   * prefetch is held for five minutes (`staleTimes.static`). `PrefetchKind`
   * is not exported from `next/navigation`; its value is the string.
   */
  useEffect(() => {
    for (const path of new Set(STEPS.map((s) => s.path))) {
      router.prefetch(`/${slug}${path}`, { kind: 'full' as PrefetchOptions['kind'] });
    }
  }, [router, slug]);

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

  /*
   * Take the tour to the step's page, and light the element the moment it
   * exists — not when the page has finished loading. Checked at once, then on
   * every DOM change, so a same-page step is one frame and a cross-page step
   * lands as soon as its element is committed.
   */
  useEffect(() => {
    const href = `/${slug}${step.path}`;
    let frame = 0;
    let observer: MutationObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Never light nothing: close up the counter and carry on the way the
    // reader was going. Backing past the first step turns forward.
    const giveUp = () => {
      observer?.disconnect();
      skip(index);
      let next = index + direction.current;
      while (next >= 0 && next < STEPS.length && skipped.has(next)) next += direction.current;
      if (next < 0) next = index + 1;
      if (next >= STEPS.length) finish();
      else setIndex(next);
    };

    if (pathname !== href) {
      // Another page: dim the whole screen until it arrives. On the same page
      // the old spotlight stays up and moves, rather than blinking out.
      setLayout(null);
      router.push(href);
      timer = setTimeout(giveUp, FIND_TIMEOUT_MS);
      return () => clearTimeout(timer);
    }

    const light = (el: HTMLElement) => {
      observer?.disconnect();
      if (timer) clearTimeout(timer);
      placeInView(el);
      const track = () => {
        setLayout((prev) => sameLayout(prev, measure(el, dialog.current, index)));
        frame = requestAnimationFrame(track);
      };
      track();
    };

    const found = findTarget(step.target);
    if (found) {
      light(found);
    } else {
      observer = new MutationObserver(() => {
        const el = findTarget(step.target);
        if (el) light(el);
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      timer = setTimeout(giveUp, FIND_TIMEOUT_MS);
    }
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      if (timer) clearTimeout(timer);
    };
    // `skipped` is read for the skip path only and deliberately not a
    // dependency: re-running on it would restart the search for the step it
    // just added.
  }, [index, pathname, slug]);

  // Focus into the caption on every step, so a screen reader reads it.
  useEffect(() => {
    primary.current?.focus({ preventScroll: true });
  }, [index]);

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

  // 150ms: long enough to see where the light went, short enough never to be
  // waited for. None at all under reduced motion.
  const motion = reduced ? '' : 'transition-[top,left,width,height] duration-150 ease-out';
  const lit = layout?.lit ?? null;

  return createPortal(
    <div className="print-hidden">
      {/* Catches every click: nothing behind the tour is live while it runs. */}
      <div className="fixed inset-0 z-[80]" aria-hidden="true" />
      {lit ? (
        <div
          aria-hidden="true"
          data-tour-spotlight={layout!.step}
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
        className={`fixed inset-x-4 bottom-4 z-[82] rounded-[12px] bg-surface p-4 shadow-[var(--shadow-pop)] sm:inset-x-auto sm:bottom-auto sm:w-[22rem] ${
          reduced ? '' : 'sm:transition-[top,left] sm:duration-150 sm:ease-out'
        }`}
        style={layout?.caption}
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
type Layout = {
  /** The step this layout was measured for, so a test can wait on it. */
  step: number;
  lit: Rect;
  /** Fixed position on a wide screen; undefined docks it (the phone layout). */
  caption: React.CSSProperties | undefined;
};

/** Below this width the caption docks to the bottom edge (`inset-x-4 bottom-4`). */
const DOCKED_BELOW = 640;
const CAPTION_WIDTH = 352;
const GAP = 12;
const EDGE = 16;

function findTarget(name: string): HTMLElement | null {
  // The first one with a box: a phone and a desktop layout can both be in the
  // document, and a hidden one measures zero.
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

/** The sticky top bar's bottom edge, or 0 where the element is inside it. */
function headerBottom(el: HTMLElement): number {
  const bar = document.querySelector<HTMLElement>('[data-topbar]');
  if (!bar || bar.contains(el)) return 0;
  return bar.getBoundingClientRect().bottom;
}

/**
 * Scroll the element to just under the sticky top bar, instantly. Measured
 * rather than `scrollIntoView`, because the bar is sticky and its height
 * changes with the width — at 390 its controls wrap to three rows — so no
 * fixed `scroll-margin-top` is right at every width. An element inside the bar
 * is already in view.
 */
function placeInView(el: HTMLElement) {
  const bar = document.querySelector<HTMLElement>('[data-topbar]');
  if (bar?.contains(el)) return;
  const offset = (bar?.getBoundingClientRect().height ?? 0) + GAP;
  const top = el.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
}

/**
 * Where the light and the caption go, so that neither the sticky bar nor the
 * caption ever covers the lit element.
 *
 * The light never starts above the bar's bottom edge. On a phone the caption
 * is docked to the bottom and the light ends above it. On a wide screen the
 * caption takes whichever side has room — below, above, right, left — and
 * where none does (a card taller than the screen), it docks to the bottom
 * and the light is cut off above it: the part of the element in view is lit,
 * and nothing lit is under the caption.
 */
function measure(el: HTMLElement, dialog: HTMLDivElement | null, step: number): Layout {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const ceiling = headerBottom(el) + (headerBottom(el) > 0 ? 4 : 0);
  const captionHeight = dialog?.offsetHeight ?? 180;

  let top = Math.max(r.top - PAD, ceiling);
  let bottom = Math.min(r.bottom + PAD, vh - 8);
  const left = Math.max(r.left - PAD, 4);
  const right = Math.min(r.right + PAD, vw - 4);

  let caption: React.CSSProperties | undefined;
  if (vw < DOCKED_BELOW) {
    bottom = Math.min(bottom, vh - EDGE - captionHeight - GAP);
  } else {
    const alignLeft = Math.min(Math.max(EDGE, left), vw - CAPTION_WIDTH - EDGE);
    const alignTop = Math.min(Math.max(Math.max(EDGE, ceiling), top), vh - captionHeight - EDGE);
    if (vh - (bottom + GAP) >= captionHeight + EDGE) {
      caption = { top: bottom + GAP, left: alignLeft };
    } else if (top - GAP - captionHeight >= Math.max(EDGE, ceiling)) {
      caption = { top: top - GAP - captionHeight, left: alignLeft };
    } else if (vw - (right + GAP) >= CAPTION_WIDTH + EDGE) {
      caption = { top: alignTop, left: right + GAP };
    } else if (left - GAP - CAPTION_WIDTH >= EDGE) {
      caption = { top: alignTop, left: left - GAP - CAPTION_WIDTH };
    } else {
      const captionTop = vh - captionHeight - EDGE;
      caption = { top: captionTop, left: alignLeft };
      bottom = Math.min(bottom, captionTop - GAP);
    }
  }
  if (bottom < top + 24) bottom = top + 24;
  return { step, lit: { top, left, width: right - left, height: bottom - top }, caption };
}

/** The same object when nothing moved, so the tracking loop does not re-render every frame. */
function sameLayout(prev: Layout | null, next: Layout): Layout {
  if (
    prev &&
    prev.step === next.step &&
    prev.lit.top === next.lit.top &&
    prev.lit.left === next.lit.left &&
    prev.lit.width === next.lit.width &&
    prev.lit.height === next.lit.height &&
    prev.caption?.top === next.caption?.top &&
    prev.caption?.left === next.caption?.left
  ) {
    return prev;
  }
  return next;
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
