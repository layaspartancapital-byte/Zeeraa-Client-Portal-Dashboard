/**
 * "Sync now" is open to every member of a tenant, clients included, so it is
 * throttled: at most one manual sync per tenant every five minutes, whoever
 * asks. Each one spends the tenant's API quota and a Neon wake-up, and a
 * client pressing it twice gets the same data twice.
 *
 * The rule is here so the endpoint and its tests cannot disagree about it;
 * `runManualSync` in `@zeeraa/jobs` enforces it under a per-tenant lock.
 */
export const MANUAL_SYNC_INTERVAL_MINUTES = 5;

export type ManualSyncVerdict =
  | { allowed: true }
  | { allowed: false; lastAt: Date; nextAt: Date; message: string };

/** Whether a manual sync may start at `now`, given when the last one started. */
export function manualSyncVerdict(
  lastStartedAt: Date | null,
  now: Date,
  intervalMinutes = MANUAL_SYNC_INTERVAL_MINUTES,
): ManualSyncVerdict {
  if (!lastStartedAt) return { allowed: true };
  const nextAt = new Date(lastStartedAt.getTime() + intervalMinutes * 60_000);
  if (now >= nextAt) return { allowed: true };
  return { allowed: false, lastAt: lastStartedAt, nextAt, message: manualSyncWaitMessage(lastStartedAt, nextAt, now) };
}

/** "Synced 2 min ago, next available in 3 min". */
export function manualSyncWaitMessage(lastAt: Date, nextAt: Date, now: Date): string {
  const ago = Math.max(0, Math.floor((now.getTime() - lastAt.getTime()) / 60_000));
  const wait = Math.max(1, Math.ceil((nextAt.getTime() - now.getTime()) / 60_000));
  return `Synced ${ago === 0 ? 'just now' : `${ago} min ago`}, next available in ${wait} min`;
}
