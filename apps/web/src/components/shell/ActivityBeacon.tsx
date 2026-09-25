'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

/** Mirrors `ACTIVITY_INTERVAL_MS` in `lib/activity.ts`, which is server-only. */
const INTERVAL_MS = 60 * 1000;

/**
 * Tells the server which page this person is on, at most once a minute.
 *
 * Keyed on the pathname and nothing else, so `AutoRefresh` re-rendering the
 * page — which hands this component a fresh `record` — is not a visit. A page
 * reached inside the minute is held and sent when it is up, so the last page
 * recorded is the one they stayed on, not the one they passed through.
 */
export function ActivityBeacon({ record }: { record: (path: string) => Promise<void> }) {
  const pathname = usePathname();
  const recordRef = useRef(record);
  recordRef.current = record;
  const lastSent = useRef(0);

  useEffect(() => {
    const send = () => {
      lastSent.current = Date.now();
      recordRef.current(pathname).catch(() => {});
    };
    const wait = lastSent.current + INTERVAL_MS - Date.now();
    if (wait <= 0) {
      send();
      return;
    }
    const timer = window.setTimeout(send, wait);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  return null;
}
