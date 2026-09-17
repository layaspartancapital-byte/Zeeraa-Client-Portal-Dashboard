import { sql } from 'drizzle-orm';
import type { Role } from '@zeeraa/core';
import { getDb, type Database } from './client';

export type TenantContext = {
  tenantId: string;
  userId: string;
  role: Role;
};

/**
 * Runs `fn` inside a transaction that carries the tenant context as
 * transaction-local settings, which is what every row level security policy
 * reads.
 *
 * Two properties matter:
 *
 * 1. `set_config(..., true)` scopes the setting to the transaction, so a
 *    connection returned to the pool cannot carry one tenant's context into
 *    the next request. A session-level `SET` here would be a cross-tenant leak
 *    waiting for a busy afternoon.
 *
 * 2. Outside this helper there is no tenant context at all, so
 *    `app.current_tenant_id()` is null, every policy evaluates to false and
 *    every tenant-scoped query returns zero rows. The failure mode of
 *    forgetting the wrapper is an empty screen, never another client's data.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (tx: Database) => Promise<T>,
  db: Database = getDb(),
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.current_tenant_id', ${ctx.tenantId}, true),
        set_config('app.current_user_id', ${ctx.userId}, true),
        set_config('app.current_user_role', ${ctx.role}, true)
    `);
    return fn(tx as unknown as Database);
  });
}

/**
 * Reads that legitimately span tenants: the tenant switcher listing a Zeeraa
 * user's memberships, and the grouped notification panel.
 *
 * There is no escape hatch here — the `memberships` policy admits a user's own
 * rows, so this sets the user but no tenant. Tenant-scoped tables still return
 * nothing.
 */
export async function withUserOnly<T>(
  userId: string,
  fn: (tx: Database) => Promise<T>,
  db: Database = getDb(),
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_user_id', ${userId}, true)`);
    return fn(tx as unknown as Database);
  });
}
