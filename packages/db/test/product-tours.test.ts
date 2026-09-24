/**
 * The product tour's completion row is its user's alone (migration 0033).
 *
 * It is not tenant data, so the tenant policies do not guard it; the one
 * question is "is this row mine". A user in the same tenant — or a Zeeraa admin
 * — can neither read somebody else's row nor write one on their behalf, and
 * nobody can delete one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import * as schema from '../src/schema';
import { withTenant } from '../src/tenant-context';
import { appClient, asOwner, cleanup, failure, ownerClient, seedTwoTenants, type Fixture } from './fixtures';

const owner = ownerClient();
const app = appClient();
let fx: Fixture;

const as = (userId: string, role: 'zeeraa_admin' | 'client_admin' = 'client_admin') =>
  <T,>(fn: Parameters<typeof withTenant<T>>[1]) =>
    withTenant({ tenantId: fx.tenantA, userId, role }, fn, app.db);

beforeAll(async () => {
  fx = await seedTwoTenants(owner.db);
  await asOwner(owner.db, (tx) =>
    tx.insert(schema.productTours).values({ userId: fx.clientAdminA, tour: 'first-login', version: 1 }),
  );
});

afterAll(async () => {
  await asOwner(owner.db, (tx) =>
    tx
      .delete(schema.productTours)
      .where(inArray(schema.productTours.userId, [fx.clientAdminA, fx.zeeraaAdminAOnly])),
  );
  await cleanup(owner.db, fx);
  await Promise.all([owner.client.end(), app.client.end()]);
});

describe('product_tours', () => {
  it('shows a user their own completion', async () => {
    const rows = await as(fx.clientAdminA)((tx) => tx.select().from(schema.productTours));
    expect(rows.map((r) => [r.userId, r.tour, r.version])).toEqual([[fx.clientAdminA, 'first-login', 1]]);
  });

  it('hides it from anybody else in the tenant, a Zeeraa admin included', async () => {
    const rows = await as(fx.zeeraaAdminAOnly, 'zeeraa_admin')((tx) =>
      tx.select().from(schema.productTours).where(eq(schema.productTours.userId, fx.clientAdminA)),
    );
    expect(rows).toEqual([]);
  });

  it('lets a user record their own completion and replay it', async () => {
    await as(fx.zeeraaAdminAOnly, 'zeeraa_admin')((tx) =>
      tx
        .insert(schema.productTours)
        .values({ userId: fx.zeeraaAdminAOnly, tour: 'first-login', version: 1 })
        .onConflictDoUpdate({
          target: [schema.productTours.userId, schema.productTours.tour, schema.productTours.version],
          set: { completedAt: new Date() },
        }),
    );
    const rows = await as(fx.zeeraaAdminAOnly, 'zeeraa_admin')((tx) => tx.select().from(schema.productTours));
    expect(rows).toHaveLength(1);
  });

  it('refuses writing a row for somebody else', async () => {
    const denied = await failure(() =>
      as(fx.clientAdminA)((tx) =>
        tx.insert(schema.productTours).values({ userId: fx.zeeraaAdminAOnly, tour: 'first-login', version: 2 }),
      ),
    );
    expect(denied.code).toBe('42501');
    expect(denied.message).toMatch(/row-level security/);
  });

  it('refuses changing somebody else’s row, silently matching nothing', async () => {
    const changed = await as(fx.zeeraaAdminAOnly, 'zeeraa_admin')((tx) =>
      tx
        .update(schema.productTours)
        .set({ completedAt: new Date(0) })
        .where(eq(schema.productTours.userId, fx.clientAdminA))
        .returning(),
    );
    expect(changed).toEqual([]);
  });

  it('grants no delete, even of a row the user owns', async () => {
    const denied = await failure(() =>
      as(fx.clientAdminA)((tx) =>
        tx.delete(schema.productTours).where(eq(schema.productTours.userId, fx.clientAdminA)),
      ),
    );
    expect(denied.code).toBe('42501');
    expect(denied.message).toMatch(/permission denied/);
  });
});
