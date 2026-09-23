'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';

/**
 * Every dashboard page refetches itself on the Salesforce cadence.
 *
 * These screens are meant to be left open — on a wall, on a second monitor, in
 * a tab somebody returns to after a meeting. Salesforce syncs every ten minutes
 * (`/api/cron/salesforce`), so a page rendered at nine and read at two would
 * show five-hour-old deals behind a freshness strip rendered at nine too.
 *
 * `router.refresh()` re-runs the server components and swaps the result in:
 * no navigation, so the URL — the picked date range with it — scroll position
 * and client state are kept. It is deliberately not `location.reload()`, which
 * is jarring on a screen somebody is reading and replays every chart's
 * entrance.
 *
 * Nothing runs while the tab is hidden; on return it refreshes at once if a
 * refresh came due while away, so a laptop shut for the weekend wakes up to one
 * request, not dozens. The component stays mounted across a refresh, so the
 * clock is the last refresh, not the first render — measuring from the mount
 * made every refresh after the first read as overdue.
 */
export const REFRESH_INTERVAL_SECONDS = 600;

export function AutoRefresh({
  /** Seconds between refreshes. Matches the Salesforce sync. */
  intervalSeconds = REFRESH_INTERVAL_SECONDS,
}: {
  intervalSeconds?: number;
}) {
  const router = useRouter();
  const [refreshedAt, setRefreshedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const last = useRef(refreshedAt);
  const age = now - refreshedAt;

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    const intervalMs = intervalSeconds * 1000;
    let timer: number | undefined;

    const refresh = () => {
      const at = Date.now();
      last.current = at;
      setRefreshedAt(at);
      setNow(at);
      setRefreshing(true);
      router.refresh();
      // Cosmetic: `router.refresh()` has no completion callback. A second is
      // long enough to register and short enough not to lie about the fetch.
      window.setTimeout(() => setRefreshing(false), 1000);
      schedule();
    };
    const schedule = () => {
      window.clearTimeout(timer);
      if (document.visibilityState !== 'visible') return;
      timer = window.setTimeout(refresh, Math.max(0, intervalMs - (Date.now() - last.current)));
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        window.clearTimeout(timer);
        return;
      }
      if (Date.now() - last.current >= intervalMs) refresh();
      else schedule();
    };

    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router, intervalSeconds]);

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
