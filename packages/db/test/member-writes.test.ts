/**
 * Members read their tenant's data and do not write it; nobody edits their own
 * account row except by changing their password (migration 0028).
 *
 * Through the application role, as the application connects. Every assertion
 * is scoped to the fixture's own tenants and rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withMaintenance, withTenant, withUserOnly } from '../src/tenant-context';
import * as schema from '../src/schema/index';
import {
  appClient,
  asOwner,
  cleanup,
  failure,
  maintClient,
  ownerClient,
  seedTwoTenants,
  type Fixture,
} from './fixtures';

const owner = ownerClient();
const app = appClient();
const maint = maintClient();
let fx: Fixture;

beforeAll(async () => {
  fx = await seedTwoTenants(owner.db);
});

afterAll(async () => {
  await cleanup(owner.db, fx);
  await owner.client.end();
  await app.client.end();
  await maint.client.end();
});

const clientAdmin = () => ({ tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' as const });
const clientViewer = () => ({ tenantId: fx.tenantB, userId: fx.clientViewerB, role: 'client_viewer' as const });
const zeeraaAdmin = () => ({ tenantId: fx.tenantA, userId: fx.zeeraaAdmin, role: 'zeeraa_admin' as const });

describe('a member of the tenant', () => {
  it('still reads the tenant data', async () => {
    const rows = await withTenant(clientAdmin(), (tx) => tx.select().from(schema.opportunities), app.db);
    expect(rows.map((r) => r.externalId)).toContain('A-OPP-1');
  });

  it.each([
    ['client admin', clientAdmin],
    ['client viewer', clientViewer],
  ] as const)('as a %s cannot insert tenant configuration', async (_label, ctx) => {
    const c = ctx();
    const error = await failure(() =>
      withTenant(
        c,
        (tx) =>
          tx.insert(schema.tenantConfig).values({ tenantId: c.tenantId, key: `probe-${Date.now()}`, value: {} }),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');
  });

  it('cannot update or delete a CRM row', async () => {
    const updated = await withTenant(
      clientAdmin(),
      (tx) =>
        tx
          .update(schema.opportunities)
          .set({ currentStage: 'tampered' })
          .where(eq(schema.opportunities.externalId, 'A-OPP-1'))
          .returning(),
      app.db,
    );
    expect(updated).toHaveLength(0);
    const deleted = await withTenant(
      clientAdmin(),
      (tx) => tx.delete(schema.opportunities).where(eq(schema.opportunities.externalId, 'A-OPP-1')).returning(),
      app.db,
    );
    expect(deleted).toHaveLength(0);
    const [row] = await asOwner(owner.db, (tx) =>
      tx
        .select({ stage: schema.opportunities.currentStage })
        .from(schema.opportunities)
        .where(and(eq(schema.opportunities.externalId, 'A-OPP-1'), eq(schema.opportunities.tenantId, fx.tenantA))),
    );
    expect(row?.stage).toBe('funded');
  });
});

describe('a Zeeraa admin of the tenant', () => {
  it('may write tenant data, in their own tenant', async () => {
    const key = `za-probe-${Date.now()}`;
    await withTenant(
      zeeraaAdmin(),
      (tx) => tx.insert(schema.tenantConfig).values({ tenantId: fx.tenantA, key, value: {} }),
      app.db,
    );
    const removed = await withTenant(
      zeeraaAdmin(),
      (tx) =>
        tx
          .delete(schema.tenantConfig)
          .where(and(eq(schema.tenantConfig.tenantId, fx.tenantA), eq(schema.tenantConfig.key, key)))
          .returning(),
      app.db,
    );
    expect(removed).toHaveLength(1);
  });

  it('may not write into another tenant', async () => {
    const error = await failure(() =>
      withTenant(
        zeeraaAdmin(),
        (tx) => tx.insert(schema.tenantConfig).values({ tenantId: fx.tenantB, key: 'smuggled', value: {} }),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');
  });
});

describe('your own account row', () => {
  it('cannot be edited directly — not your email', async () => {
    // Outside the flow no policy admits an update of your own row, so under
    // FORCE it matches nothing — the row is simply not there to update.
    const rows = await withUserOnly(
      fx.clientAdminA,
      (tx) =>
        tx
          .update(schema.users)
          .set({ email: 'taken-over@example.test' })
          .where(eq(schema.users.id, fx.clientAdminA))
          .returning(),
      app.db,
    );
    expect(rows).toHaveLength(0);
    const [row] = await asOwner(owner.db, (tx) =>
      tx.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, fx.clientAdminA)),
    );
    expect(row?.email).not.toBe('taken-over@example.test');
  });

  it('cannot clear a forced password change without a new password', async () => {
    const rows = await withUserOnly(
      fx.clientAdminA,
      (tx) =>
        tx
          .update(schema.users)
          .set({ mustChangePassword: false })
          .where(eq(schema.users.id, fx.clientAdminA))
          .returning(),
      app.db,
    ).catch(() => []);
    expect(rows).toHaveLength(0);
  });

  it('changes through the flow: a new hash, the flag cleared, nothing else', async () => {
    const rows = await withUserOnly(
      fx.clientAdminA,
      async (tx) => {
        await tx.execute(sql`select set_config('app.password_change', 'on', true)`);
        return tx
          .update(schema.users)
          .set({ passwordHash: `hash-${Date.now()}`, mustChangePassword: false, passwordUpdatedAt: new Date() })
          .where(eq(schema.users.id, fx.clientAdminA))
          .returning({ id: schema.users.id });
      },
      app.db,
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses anything else riding on the flow', async () => {
    const error = await failure(() =>
      withUserOnly(
        fx.clientAdminA,
        async (tx) => {
          await tx.execute(sql`select set_config('app.password_change', 'on', true)`);
          return tx
            .update(schema.users)
            .set({ passwordHash: `hash-${Date.now()}`, email: 'riding@example.test' })
            .where(eq(schema.users.id, fx.clientAdminA));
        },
        app.db,
      ),
    );
    expect(error.message).toMatch(/new password and nothing else/);
  });

  it("cannot be reset by a Zeeraa admin through the admin policy — that is still one's own row", async () => {
    const error = await failure(() =>
      withTenant(
        zeeraaAdmin(),
        (tx) =>
          tx
            .update(schema.users)
            .set({ passwordHash: 'self-reset', mustChangePassword: true })
            .where(eq(schema.users.id, fx.zeeraaAdmin)),
        app.db,
      ),
    );
    expect(error.message).toMatch(/not edited directly/);
  });
});

describe('admin recovery, through the maintenance role', () => {
  /*
   * `scripts/set-password.ts` is how a locked-out admin gets back in, and 0028
   * broke it: the guard ran as the invoker and called into schema `app`, which
   * the maintenance role cannot use, so the UPDATE failed before the guard had
   * decided anything. 0029 runs the guard as its owner. This is the script's
   * own statement, against a fixture user.
   */
  it('sets somebody else\'s password and ends their sessions', async () => {
    const updated = await withMaintenance(maint.db, async (tx) => {
      const rows = await tx
        .update(schema.users)
        .set({ passwordHash: `recovery-${Date.now()}`, mustChangePassword: true, passwordUpdatedAt: new Date() })
        .where(eq(schema.users.id, fx.clientViewerB))
        .returning({ id: schema.users.id });
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, fx.clientViewerB));
      return rows;
    });
    expect(updated).toHaveLength(1);

    const [row] = await asOwner(owner.db, (tx) =>
      tx
        .select({ mustChangePassword: schema.users.mustChangePassword })
        .from(schema.users)
        .where(eq(schema.users.id, fx.clientViewerB)),
    );
    expect(row?.mustChangePassword).toBe(true);
  });
});
