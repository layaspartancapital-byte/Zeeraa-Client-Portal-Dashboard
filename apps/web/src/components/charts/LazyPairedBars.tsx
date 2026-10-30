'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import type { PairedBars as PairedBarsType } from '@/components/charts/PairedBars';

/** The chart's code, fetched only once it is wanted. */
const PairedBars = dynamic(() => import('@/components/charts/PairedBars').then((m) => m.PairedBars), {
  ssr: false,
  loading: () => null,
});

/**
 * `PairedBars`, drawn only once it scrolls near the viewport (30 October
 * 2026): the charting library stays out of the page's first load, and a
 * reader who never scrolls to the chart never downloads it. The space is
 * reserved meanwhile, so nothing below it moves.
 */
export function LazyPairedBars(props: ComponentProps<typeof PairedBarsType>) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || shown) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown]);
  return (
    <div ref={ref} className="min-w-0" style={{ minHeight: (props.height ?? 260) + 24 }}>
      {shown && <PairedBars {...props} />}
    </div>
  );
}
