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
 * 28,000 rows cost more than the cache saved. Only a report that reads calls
 * keys on the deliveries (`scope: 'calls'`); every other report keys on the
 * rest alone, so a call ending does not recompute the funnel. Before 30
 * October 2026 every delivery reset every report, and through the desk's hours
 * a call every few minutes meant almost no page was ever served from here. A
 * report that reads calls only through another result takes that result as an
 * argument instead, and is keyed on it (`windowBuckets` on `sourcesThrough`).
 * A config table with no timestamp
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

/**
 * The tenant's data version, in two parts: the newest write any report could
 * read apart from calls (`base`), and the newest call delivery (`calls`). Once
 * per request.
 */
export const dataVersion = cache(async (session: TenantSession): Promise<{ base: string; calls: string }> => {
  const [row] = await queryTenant(session, (tx) =>
    tx.execute<{ base: string; calls: string | null }>(sql`
      select concat_ws('|',
        (select max(coalesce(finished_at, started_at)) from sync_runs where tenant_id = ${session.tenant.id}),
        (select count(*) from sync_runs where tenant_id = ${session.tenant.id}),
        (select max(updated_at) from tenant_config where tenant_id = ${session.tenant.id}),
        (select count(*) from tenant_config where tenant_id = ${session.tenant.id}),
        (select max(frozen_at) from baseline_snapshots where tenant_id = ${session.tenant.id}),
        (select max(checked_at) from reconciliation_checks where tenant_id = ${session.tenant.id}),
        (select count(*) from funnel_stages where tenant_id = ${session.tenant.id}),
        (select count(*) from tenant_metrics where tenant_id = ${session.tenant.id}),
        (select count(*) from engagement_targets where tenant_id = ${session.tenant.id}),
        (select count(*) from blocked_dependencies where tenant_id = ${session.tenant.id})
      ) as base,
      (select max(last_received_at)::text from webhook_deliveries where tenant_id = ${session.tenant.id}) as calls`),
  );
  return { base: row?.base ?? '', calls: row?.calls ?? '' };
});

/**
 * What a report reads, for its key: `data` is everything but calls, `calls`
 * is everything.
 */
export type CacheScope = 'data' | 'calls';

/**
 * `fn`'s result for these arguments, from the cache while the data version
 * holds. A failed computation is not kept.
 */
export async function cachedReport<T>(
  session: TenantSession,
  name: string,
  args: readonly unknown[],
  fn: () => Promise<T>,
  scope: CacheScope = 'data',
): Promise<T> {
  // The kill switch: every report computed afresh, exactly as before the cache.
  if (process.env.REPORT_CACHE === 'off') return fn();
  const version = await dataVersion(session);
  const key = [
    session.tenant.id,
    session.tenant.role,
    version.base,
    scope === 'calls' ? version.calls : '',
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
  scope: CacheScope = 'data',
): (session: TenantSession, ...args: A) => Promise<T> {
  return (session, ...args) => cachedReport(session, name, args, () => fn(session, ...args), scope);
}

const byContent = new Map<string, Promise<unknown>>();

/**
 * `fn`'s result, kept for as long as `digest` — a hash of exactly what `fn`
 * reads — holds, whatever the data version does. For a value that changes on
 * its own schedule and is expensive to ship, like the tenant's logo; the
 * digest is read on every request and is a few bytes.
 */
export async function cachedByDigest<T>(
  session: TenantSession,
  name: string,
  digest: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (process.env.REPORT_CACHE === 'off') return fn();
  const key = [session.tenant.id, name, digest].join('\u0001');
  let value = byContent.get(key) as Promise<T> | undefined;
  if (!value) {
    value = fn();
    byContent.set(key, value);
    value.catch(() => byContent.delete(key));
    if (byContent.size > MAX_ENTRIES) byContent.delete(byContent.keys().next().value!);
  }
  return structuredClone(await value);
}
