/**
 * A delivery record is tenant data, and read-only to the application.
 *
 * It names a client's vendor, their traffic and — in `reasons` — the values
 * their vendor is sending, which for a call endpoint is a disposition
 * vocabulary. That it is a diagnostic does not put it outside the model; the
 * whole point of FORCE row level security here is that nothing is.
 *
 * The second property is the interesting one. The application may read this
 * table and may not write it: a delivery is something that happened, and a
 * screen that could edit the record of what happened is a screen that could
 * make a silent endpoint look busy. Row level security cannot express that, so
 * the column grant does — the same mechanism that keeps `memberships.role` out
 * of reach of `memberships_update_own`.
 *
 * Scoped to the fixture's own tenants throughout: packages test concurrently
 * against one Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../src/schema';
import { withJobTenant, withTenant } from '../src/tenant-context';
import {
  appClient,
  asOwner,
  cleanup,
  failure,
  ownerClient,
  seedTwoTenants,
  type Fixture,
} from './fixtures';

const owner = ownerClient();
const app = appClient();
let fx: Fixture;

beforeAll(async () => {
  fx = await seedTwoTenants(owner.db);
  await asOwner(owner.db, async (tx) => {
    await tx.insert(schema.webhookDeliveries).values([
      {
        tenantId: fx.tenantA,
        source: 'aloware',
        day: '2026-09-22',
        received: 12,
        accepted: 11,
        rejected: 1,
        reasons: { 'call still in flight (ringing)': 1 },
      },
      {
        tenantId: fx.tenantB,
        source: 'aloware',
        day: '2026-09-22',
        received: 300,
        accepted: 0,
        rejected: 300,
        reasons: { 'b-secret-disposition': 300 },
      },
    ]);
  });
});

afterAll(async () => {
  await cleanup(owner.db, fx);
  await Promise.all([owner.client.end(), app.client.end()]);
});

describe('webhook_deliveries', () => {
  it('shows a client its own deliveries and none of anybody else’s', async () => {
    const rows = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) => tx.select().from(schema.webhookDeliveries),
      app.db,
    );
    // Both halves. Dropping the policy returns nothing, and `every()` over an
    // empty array is vacuously true — a test that only asserts the absence of
    // the other tenant passes whether or not the control exists.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === fx.tenantA)).toBe(true);
    expect(rows.some((r) => r.received === 300)).toBe(false);
  });

  it('refuses the application a write, by the column grant', async () => {
    // Not by policy: row level security cannot restrict a column, and the
    // `tenant_isolation` policy would happily admit this row.
    const denied = await failure(() =>
      withTenant(
        { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
        (tx) =>
          tx.insert(schema.webhookDeliveries).values({
            tenantId: fx.tenantA,
            source: 'aloware',
            day: '2026-09-23',
            received: 999,
          }),
        app.db,
      ),
    );
    expect(denied.code).toBe('42501');
  });

  it('refuses the application an update to a delivery it can see', async () => {
    const denied = await failure(() =>
      withTenant(
        { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
        (tx) =>
          tx
            .update(schema.webhookDeliveries)
            .set({ received: 0 })
            .where(eq(schema.webhookDeliveries.tenantId, fx.tenantA)),
        app.db,
      ),
    );
    expect(denied.code).toBe('42501');
  });

  it('lets the jobs role write, because a delivery is ingestion', async () => {
    await withJobTenant(fx.tenantA, (tx) =>
      tx.insert(schema.webhookDeliveries).values({
        tenantId: fx.tenantA,
        source: 'aloware',
        day: '2026-09-21',
        received: 1,
      }),
    );
    const rows = await withJobTenant(fx.tenantA, (tx) =>
      tx.select().from(schema.webhookDeliveries),
    );
    expect(rows.every((r) => r.tenantId === fx.tenantA)).toBe(true);
    expect(rows.some((r) => r.day === '2026-09-21')).toBe(true);
  });

  it('refuses the jobs role a row written into a tenant it does not name', async () => {
    // A connector bug must not be able to reach a second client, and a
    // diagnostic writer is a connector like any other.
    const denied = await failure(() =>
      withJobTenant(fx.tenantA, (tx) =>
        tx.insert(schema.webhookDeliveries).values({
          tenantId: fx.tenantB,
          source: 'aloware',
          day: '2026-09-21',
          received: 1,
        }),
      ),
    );
    expect(denied.code).toBe('42501');
  });

  it('holds one bucket per tenant per source per day, which is what bounds it', async () => {
    // The endpoint is public. Without this index a stranger posting in a loop
    // grows the table for as long as they keep going.
    const duplicate = await failure(() =>
      withJobTenant(fx.tenantA, (tx) =>
        tx.insert(schema.webhookDeliveries).values({
          tenantId: fx.tenantA,
          source: 'aloware',
          day: '2026-09-22',
          received: 1,
        }),
      ),
    );
    expect(duplicate.code).toBe('23505');
  });
});
