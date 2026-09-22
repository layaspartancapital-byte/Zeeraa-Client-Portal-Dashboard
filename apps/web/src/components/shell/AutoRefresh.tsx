'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';

/**
 * The briefing refetches itself on the sync cadence.
 *
 * This screen has no date control and is meant to be left open — on a wall, on
 * a second monitor, in a tab somebody returns to after a meeting. Syncing is
 * hourly, so a page rendered at nine and read at two is showing five-hour-old
 * figures with a freshness strip that was also rendered at nine, which is the
 * worst of both: stale data wearing a timestamp that says it is current.
 *
 * `router.refresh()` re-runs the server components and swaps the result in
 * without losing scroll position or client state. It is deliberately *not* a
 * `location.reload()`: a reload on a screen somebody is reading is jarring, and
 * it would replay the charts' entrance animation.
 *
 * The refresh is paused while the tab is hidden and runs once on return, so a
 * laptop that was shut for the weekend does not wake up and fire forty requests
 * before rendering.
 */
export function AutoRefresh({
  /** Seconds between refreshes. Matches the sync cadence. */
  intervalSeconds = 3600,
}: {
  intervalSeconds?: number;
}) {
  const router = useRouter();
  const [renderedAt] = useState(() => Date.now());
  const [age, setAge] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const tick = window.setInterval(() => setAge(Date.now() - renderedAt), 30_000);
    return () => window.clearInterval(tick);
  }, [renderedAt]);

  useEffect(() => {
    const due = () => Date.now() - renderedAt >= intervalSeconds * 1000;

    const refresh = () => {
      setRefreshing(true);
      router.refresh();
      // The flag is cosmetic: `router.refresh()` resolves when the server
      // responds, and there is no callback for it. A second is long enough for
      // the spinner to register as feedback and short enough not to lie about
      // how long the fetch took.
      window.setTimeout(() => setRefreshing(false), 1000);
    };

    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, intervalSeconds * 1000);

    const onVisible = () => {
      if (document.visibilityState === 'visible' && due()) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router, renderedAt, intervalSeconds]);

  const minutes = Math.floor(age / 60_000);

  return (
    <span className="inline-flex items-center gap-1 text-[12px] text-text-3 print-hidden">
      <RefreshCw
        aria-hidden="true"
        className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`}
      />
      {/* Not "live". The page is as current as its last render, and the number
          that matters — how current the *data* is — is the freshness strip
          beside this. */}
      <span className="tabular">
        {refreshing
          ? 'refreshing'
          : minutes < 1
            ? 'drawn just now'
            : `drawn ${minutes}m ago`}
      </span>
      <span className="sr-only">
        This page refetches itself every {Math.round(intervalSeconds / 60)} minutes.
      </span>
    </span>
  );
}
