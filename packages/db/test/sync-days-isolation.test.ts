/**
 * The per-day read ledger is tenant data, and read-only to the application.
 *
 * It says which days a client's sources were read, which is what decides
 * whether a figure renders or shows `Not measured`. A screen that could write
 * it could make an unread day look measured, so the application reads it and
 * the ingestion role writes it — and neither reaches another tenant's rows.
 *
 * Scoped to the fixture's own tenants throughout: packages test concurrently
 * against one Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  await asOwner(owner.db, (tx) =>
    tx.insert(schema.syncDays).values([
      { tenantId: fx.tenantA, platform: 'meta', day: '2026-09-18', final: true },
      { tenantId: fx.tenantB, platform: 'meta', day: '2026-09-19', final: true },
    ]),
  );
});

afterAll(async () => {
  await cleanup(owner.db, fx);
  await Promise.all([owner.client.end(), app.client.end()]);
});

const clientAdminA = () => ({ tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' as const });

describe('sync_days', () => {
  it('shows a client its own read days and none of anybody else’s', async () => {
    const rows = await withTenant(clientAdminA(), (tx) => tx.select().from(schema.syncDays), app.db);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === fx.tenantA)).toBe(true);
  });

  it('refuses a member a write — an unread day must not be made to look read', async () => {
    const rows = await withTenant(
      clientAdminA(),
      (tx) =>
        tx
          .insert(schema.syncDays)
          .values({ tenantId: fx.tenantA, platform: 'meta', day: '2026-09-20', final: true })
          .returning(),
      app.db,
    ).catch((e) => e);
    expect(rows instanceof Error || (Array.isArray(rows) && rows.length === 0)).toBe(true);
  });

  it('lets the jobs role record a day, in its own tenant only', async () => {
    await withJobTenant(fx.tenantA, (tx) =>
      tx.insert(schema.syncDays).values({ tenantId: fx.tenantA, platform: 'ga4', day: '2026-09-20' }),
    );
    const denied = await failure(() =>
      withJobTenant(fx.tenantA, (tx) =>
        tx.insert(schema.syncDays).values({ tenantId: fx.tenantB, platform: 'ga4', day: '2026-09-20' }),
      ),
    );
    expect(denied.code).toBe('42501');
  });

  it('holds one row per tenant, platform and day', async () => {
    const duplicate = await failure(() =>
      withJobTenant(fx.tenantA, (tx) =>
        tx.insert(schema.syncDays).values({ tenantId: fx.tenantA, platform: 'meta', day: '2026-09-18' }),
      ),
    );
    expect(duplicate.code).toBe('23505');
  });
});
