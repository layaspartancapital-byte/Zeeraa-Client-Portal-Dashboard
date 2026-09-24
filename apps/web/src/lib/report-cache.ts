import 'server-only';
import { cache } from 'react';
import { sql } from 'drizzle-orm';
import { tenantDay } from '@zeeraa/core';
import { queryTenant, type TenantSession } from '@/lib/tenant';

/**
 * Report results, kept between syncs (24 September 2026).
 *
 * A report's result changes only when its data does, and the data changes
 * only when something writes it: a sync, a webhook call, a config row, a
 * baseline freeze, a reconciliation. So each result is keyed by the tenant's
 * **data version** — the newest of those writes — and a finished sync changes
 * the version, which changes every key: the next request recomputes and the
 * ten-minute auto-refresh always shows the latest data. No message has to
 * reach every server instance to clear anything; each one reads the version
 * (one statement) and simply stops finding the old entries.
 *
 * What the key holds, and why:
 *
 *   - **tenant and role.** A result was computed under that tenant's row level
 *     security and that role's policies, and is only ever served to a request
 *     that has passed `requireTenant` for the same tenant and role.
 *   - **the data version**, as above.
 *   - **the tenant's local day**, for the reports that measure "the last 90
 *     days" from today rather than from their arguments.
 *   - **the report and its arguments.**
 *
 * Calls arrive by webhook, and each delivery moves `webhook_deliveries`, so the
 * calls table itself is not read: under row level security a max over its
 * 28,000 rows cost more than the cache saved. A config table with no timestamp
 * of its own is caught by its row count, and
 * an entry expires after `MAX_AGE_MS` whatever happens, as the backstop for an
 * edit in place nothing records. Every hit returns a `structuredClone`, so a
 * page that sorts or annotates a result cannot change what the next request
 * gets — and Dates and Maps survive, which JSON would not.
 */

const MAX_AGE_MS = 10 * 60_000;
const MAX_ENTRIES = 400;

type Entry = { at: number; value: Promise<unknown> };
const store = new Map<string, Entry>();

/** The tenant's data version: the newest write that any report could read. Once per request. */
export const dataVersion = cache(async (session: TenantSession): Promise<string> => {
  const [row] = await queryTenant(session, (tx) =>
    tx.execute<{ v: string }>(sql`
      select concat_ws('|',
        (select max(coalesce(finished_at, started_at)) from sync_runs where tenant_id = ${session.tenant.id}),
        (select count(*) from sync_runs where tenant_id = ${session.tenant.id}),
        (select max(last_received_at) from webhook_deliveries where tenant_id = ${session.tenant.id}),
        (select max(updated_at) from tenant_config where tenant_id = ${session.tenant.id}),
        (select count(*) from tenant_config where tenant_id = ${session.tenant.id}),
        (select max(frozen_at) from baseline_snapshots where tenant_id = ${session.tenant.id}),
        (select max(checked_at) from reconciliation_checks where tenant_id = ${session.tenant.id}),
        (select count(*) from funnel_stages where tenant_id = ${session.tenant.id}),
        (select count(*) from tenant_metrics where tenant_id = ${session.tenant.id}),
        (select count(*) from engagement_targets where tenant_id = ${session.tenant.id}),
        (select count(*) from blocked_dependencies where tenant_id = ${session.tenant.id})
      ) as v`),
  );
  return row?.v ?? '';
});

/**
 * `fn`'s result for these arguments, from the cache while the data version
 * holds. A failed computation is not kept.
 */
export async function cachedReport<T>(
  session: TenantSession,
  name: string,
  args: readonly unknown[],
  fn: () => Promise<T>,
): Promise<T> {
  // The kill switch: every report computed afresh, exactly as before the cache.
  if (process.env.REPORT_CACHE === 'off') return fn();
  const version = await dataVersion(session);
  const key = [
    session.tenant.id,
    session.tenant.role,
    version,
    tenantDay(new Date(), session.tenant.timezone),
    name,
    JSON.stringify(args),
  ].join('\u0001');

  const now = Date.now();
  let entry = store.get(key);
  if (!entry || now - entry.at > MAX_AGE_MS) {
    const value = fn();
    entry = { at: now, value };
    store.set(key, entry);
    value.catch(() => {
      if (store.get(key) === entry) store.delete(key);
    });
    evict(now);
  }
  return structuredClone((await entry.value) as T);
}

function evict(now: number) {
  if (store.size <= MAX_ENTRIES) return;
  for (const [key, entry] of store) {
    if (now - entry.at > MAX_AGE_MS || store.size > MAX_ENTRIES) store.delete(key);
    if (store.size <= MAX_ENTRIES) break;
  }
}

/** The same report function, cached: `cached('windowBuckets', windowBuckets)(session, range, …)`. */
export function cached<A extends unknown[], T>(
  name: string,
  fn: (session: TenantSession, ...args: A) => Promise<T>,
): (session: TenantSession, ...args: A) => Promise<T> {
  return (session, ...args) => cachedReport(session, name, args, () => fn(session, ...args));
}
