/**
 * Contact fields and the export audit entry (migration 0046).
 *
 * `crm_contacts` is readable by a Zeeraa admin or a client admin in the
 * current tenant and by nobody else — a viewer reads nothing even in their own
 * tenant, because the policy holds whatever the application asks. Nothing in
 * the application writes it. An `export` audit entry may be written by any
 * member, as themselves and about themselves only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/schema';
import { withMaintenance, withTenant } from '../src/tenant-context';
import { appClient, cleanup, failure, ownerClient, seedTwoTenants, type Fixture } from './fixtures';

const owner = ownerClient();
const app = appClient();
let fx: Fixture;

type Role = 'zeeraa_admin' | 'client_admin' | 'client_viewer';
const inTenant = (tenantId: string, userId: string, role: Role) =>
  <T,>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant({ tenantId, userId, role }, fn, app.db);

beforeAll(async () => {
  fx = await seedTwoTenants(owner.db);
  await withMaintenance(owner.db, (tx) =>
    tx.insert(schema.crmContacts).values([
      { tenantId: fx.tenantA, object: 'lead', externalId: 'lead-a', name: 'A Person', email: 'a@example.test', phone: '555-0101' },
      { tenantId: fx.tenantB, object: 'lead', externalId: 'lead-b', name: 'B Person', email: 'b@example.test', phone: '555-0102' },
    ]),
  );
});

afterAll(async () => {
  await cleanup(owner.db, fx);
  await Promise.all([owner.client.end(), app.client.end()]);
});

describe('crm_contacts', () => {
  it("lets a Zeeraa admin and a client admin read their own tenant's contacts, and only those", async () => {
    const zeeraa = await inTenant(fx.tenantA, fx.zeeraaAdminAOnly, 'zeeraa_admin')((tx) => tx.select().from(schema.crmContacts));
    const client = await inTenant(fx.tenantA, fx.clientAdminA, 'client_admin')((tx) => tx.select().from(schema.crmContacts));
    expect(zeeraa.map((r) => r.externalId)).toEqual(['lead-a']);
    expect(client.map((r) => r.externalId)).toEqual(['lead-a']);
  });

  it("shows a viewer nothing, even in the viewer's own tenant", async () => {
    const rows = await inTenant(fx.tenantB, fx.clientViewerB, 'client_viewer')((tx) => tx.select().from(schema.crmContacts));
    expect(rows).toEqual([]);
  });

  it('refuses a write from the application, an admin included', async () => {
    const denied = await failure(() =>
      inTenant(fx.tenantA, fx.zeeraaAdminAOnly, 'zeeraa_admin')((tx) =>
        tx.insert(schema.crmContacts).values({ tenantId: fx.tenantA, object: 'lead', externalId: 'forged', name: 'X' }),
      ),
    );
    expect(denied.code).toBe('42501');
  });
});

describe('export audit entries', () => {
  const entry = (tenantId: string, userId: string) => ({
    tenantId,
    action: 'export' as const,
    actorUserId: userId,
    actorEmail: 'someone@example.test',
    subjectUserId: userId,
    subjectEmail: 'someone@example.test',
    detail: { export: 'deals', from: '2026-10-01', to: '2026-10-30', source: null, rows: 3, contacts: false },
  });

  it('lets a viewer record their own export', async () => {
    await inTenant(fx.tenantB, fx.clientViewerB, 'client_viewer')((tx) =>
      tx.insert(schema.auditEvents).values(entry(fx.tenantB, fx.clientViewerB)),
    );
    const rows = await withMaintenance(owner.db, (tx) => tx.select().from(schema.auditEvents));
    const mine = rows.filter((r) => r.tenantId === fx.tenantB && r.action === 'export');
    expect(mine.map((r) => [r.actorUserId, r.detail?.rows])).toEqual([[fx.clientViewerB, 3]]);
  });

  it('refuses an export entry naming somebody else', async () => {
    const denied = await failure(() =>
      inTenant(fx.tenantB, fx.clientViewerB, 'client_viewer')((tx) =>
        tx.insert(schema.auditEvents).values({ ...entry(fx.tenantB, fx.clientViewerB), actorUserId: fx.zeeraaAdmin }),
      ),
    );
    expect(denied.code).toBe('42501');
  });

  it('refuses an export entry in a tenant the person does not hold', async () => {
    const denied = await failure(() =>
      inTenant(fx.tenantA, fx.clientViewerB, 'client_viewer')((tx) =>
        tx.insert(schema.auditEvents).values(entry(fx.tenantA, fx.clientViewerB)),
      ),
    );
    expect(denied.code).toBe('42501');
  });
});
