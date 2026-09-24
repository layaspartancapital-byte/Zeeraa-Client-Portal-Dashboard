'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { nextRefreshAt, type BusinessHours } from '@zeeraa/core';

/**
 * Every dashboard page refetches itself on the Salesforce cadence: every ten
 * minutes while the desk is open, and two minutes past each hour otherwise.
 *
 * These screens are meant to be left open — on a wall, on a second monitor, in
 * a tab somebody returns to after a meeting. Salesforce syncs every ten minutes
 * in the desk's hours (`/api/cron/salesforce`), so a page rendered at nine and
 * read at two would show five-hour-old deals behind a freshness strip rendered
 * at nine too. Outside them it syncs hourly, and a tab refreshing every ten
 * minutes would then only keep the database awake all night: Neon suspends
 * after five idle minutes. The off-hours refresh lands at hh:02, just after
 * the hourly sync, so it wakes the database when the sync already has. The
 * schedule is `nextRefreshAt` in core, beside the rule the cron follows.
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
const HoursContext = createContext<BusinessHours | null>(null);

/** The desk's hours, from the tenant layout. Null is the 24/7 clock. */
export function RefreshHoursProvider({
  hours,
  children,
}: {
  hours: BusinessHours | null;
  children: React.ReactNode;
}) {
  return <HoursContext.Provider value={hours}>{children}</HoursContext.Provider>;
}

export function AutoRefresh() {
  const router = useRouter();
  const hours = useContext(HoursContext);
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
    let timer: number | undefined;
    const due = () => nextRefreshAt(new Date(last.current), hours).getTime();

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
      timer = window.setTimeout(refresh, Math.max(0, due() - Date.now()));
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        window.clearTimeout(timer);
        return;
      }
      if (Date.now() >= due()) refresh();
      else schedule();
    };

    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router, hours]);

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
        {hours
          ? 'This page refetches itself every 10 minutes during business hours and hourly outside them.'
          : 'This page refetches itself every 10 minutes.'}
      </span>
    </span>
  );
}
