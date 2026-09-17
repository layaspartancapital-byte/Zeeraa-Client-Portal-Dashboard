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
 *
 * Pooling. This is safe in direct connections and behind a pooler in
 * **transaction** mode (PgBouncer's `transaction`, which is what Neon's pooled
 * endpoint runs): a transaction is pinned to one server connection for its
 * whole life, so BEGIN, the set_config, the queries and COMMIT all land on the
 * same backend, and the setting is discarded with the transaction.
 *
 * It would NOT be safe behind a pooler in `statement` mode, where individual
 * statements of one transaction can be spread across backends. Do not put this
 * application behind one. `prepare: false` on the client is part of the same
 * requirement — named prepared statements do not survive transaction pooling.
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
 * Opens the maintenance door, for one transaction.
 *
 * Every tenant-scoped table carries FORCE ROW LEVEL SECURITY, so the role that
 * owns them is bound by the same policies as the application. That is what
 * makes a stray psql session or a half-written backfill script safe by default:
 * it sees nothing. Work that genuinely needs to cross tenants — seeding a new
 * client, repairing a bad import — says so here, explicitly, per transaction,
 * in a call that greps.
 *
 * Only members of `zeeraa_maintenance` can use it. The runtime role is not a
 * member, so calling this from a web request does nothing at all: the policy it
 * enables does not apply to `zeeraa_app`.
 */
export async function withMaintenance<T>(
  db: Database,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.maintenance', 'on', true)`);
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
