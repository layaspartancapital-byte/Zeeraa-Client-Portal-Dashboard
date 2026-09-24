import { vi } from 'vitest';
import { sql } from 'drizzle-orm';

/*
 * The report functions run exactly as on a page, but every query goes through
 * one read-only transaction on the maintenance role instead of a signed-in
 * person's membership: the checks read across the tenant and must not be
 * able to write.
 */
vi.mock('server-only', () => ({}));
vi.mock('@/lib/session', () => ({ readSession: async () => null }));
vi.mock('@/lib/tenant', async () => {
  const { getMaintenanceDb } = await import('@zeeraa/db');
  return {
    queryTenant: (_session: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      getMaintenanceDb().transaction(async (tx) => {
        await tx.execute(sql`set transaction read only`);
        await tx.execute(sql`select set_config('app.maintenance', 'on', true)`);
        return fn(tx);
      }),
  };
});
