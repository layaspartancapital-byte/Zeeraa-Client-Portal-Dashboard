/**
 * Each sender's copy of a call is tenant data (0043).
 *
 * It holds a merchant's keyed number and the desk's agents, exactly as `calls`
 * does, so it carries the same isolation: a member reads only their own
 * tenant's copies, the application writes none (a copy is a record of what a
 * sender delivered), and the ingestion role writes only the tenant it names.
 *
 * Scoped to the fixture's own tenants: packages test concurrently against one
 * Postgres.
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

const copy = (tenantId: string, externalId: string, sender = 'aloware') => ({
  tenantId,
  sender,
  externalId,
  occurredAt: new Date('2026-10-06T14:22:28Z'),
  direction: 'outbound',
  outcome: 'connected',
  contactKey: '5415550123',
});

beforeAll(async () => {
  fx = await seedTwoTenants(owner.db);
  await asOwner(owner.db, (tx) =>
    tx.insert(schema.callDeliveries).values([copy(fx.tenantA, 'A-1'), copy(fx.tenantB, 'B-SECRET')]),
  );
});

afterAll(async () => {
  await cleanup(owner.db, fx);
  await Promise.all([owner.client.end(), app.client.end()]);
});

describe('call_deliveries', () => {
  it('shows a client its own copies and none of anybody else’s', async () => {
    const rows = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) => tx.select().from(schema.callDeliveries),
      app.db,
    );
    // Both halves: an empty result would make `every()` vacuously true.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === fx.tenantA)).toBe(true);
    expect(rows.some((r) => r.externalId === 'B-SECRET')).toBe(false);
  });

  it('refuses the application a write, even a Zeeraa admin, by the grant', async () => {
    const denied = await failure(() =>
      withTenant(
        { tenantId: fx.tenantA, userId: fx.zeeraaAdmin, role: 'zeeraa_admin' },
        (tx) => tx.insert(schema.callDeliveries).values(copy(fx.tenantA, 'A-forged')),
        app.db,
      ),
    );
    expect(denied.code).toBe('42501');
  });

  it('lets the jobs role write its own tenant', async () => {
    await withJobTenant(fx.tenantA, (tx) => tx.insert(schema.callDeliveries).values(copy(fx.tenantA, 'A-2', 'zapier')));
    const rows = await withJobTenant(fx.tenantA, (tx) => tx.select().from(schema.callDeliveries));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === fx.tenantA)).toBe(true);
    expect(rows.some((r) => r.externalId === 'A-2')).toBe(true);
  });

  it('refuses the jobs role a copy written into a tenant it does not name', async () => {
    const denied = await failure(() =>
      withJobTenant(fx.tenantA, (tx) => tx.insert(schema.callDeliveries).values(copy(fx.tenantB, 'B-forged'))),
    );
    expect(denied.code).toBe('42501');
  });

  it('refuses the jobs role a delete: a delivered copy is a fact', async () => {
    const denied = await failure(() =>
      withJobTenant(fx.tenantA, (tx) =>
        tx.delete(schema.callDeliveries).where(eq(schema.callDeliveries.tenantId, fx.tenantA)),
      ),
    );
    expect(denied.code).toBe('42501');
  });

  it('holds one copy per sender per call', async () => {
    const duplicate = await failure(() =>
      withJobTenant(fx.tenantA, (tx) => tx.insert(schema.callDeliveries).values(copy(fx.tenantA, 'A-1'))),
    );
    expect(duplicate.code).toBe('23505');
  });
});
