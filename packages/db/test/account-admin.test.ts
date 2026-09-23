/**
 * The policies behind account administration (migrations 0017, 0019, 0027).
 *
 * Account administration is a Zeeraa admin's alone (0027). The application's
 * `canManageUsers` produces a readable error; these are what hold when
 * somebody calls the database without it:
 *
 *   1. a client admin can create, grant, remove, reset and look up nothing —
 *      in particular they cannot reset a Zeeraa admin's password, which would
 *      hand them an account that reaches every client;
 *   2. a Zeeraa admin can do all of it, in the tenant they are working in;
 *   3. nobody may promote themselves by updating their own membership row;
 *   4. a tenant always keeps one Zeeraa admin.
 *
 * Every assertion is scoped to the fixture's own tenants: these run against the
 * same Postgres as every other suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenant, withUserOnly } from '../src/tenant-context';
import * as schema from '../src/schema/index';
import { appClient, asOwner, cleanup, failure, ownerClient, seedTwoTenants, type Fixture } from './fixtures';

const owner = ownerClient();
const app = appClient();
let fx: Fixture;

/** A user created outside any tenant, to be granted access in the tests. */
let outsiderId: string;
const outsiderEmail = `outsider-${Date.now()}@example.test`;

beforeAll(async () => {
  fx = await seedTwoTenants(owner.db);
  const [row] = await asOwner(owner.db, (tx) =>
    tx.insert(schema.users).values({ email: outsiderEmail, name: 'Outsider' }).returning(),
  );
  outsiderId = row!.id;
});

afterAll(async () => {
  await asOwner(owner.db, (tx) => tx.delete(schema.users).where(eq(schema.users.id, outsiderId)));
  await cleanup(owner.db, fx);
  await owner.client.end();
  await app.client.end();
});

const ctx = () => ({ tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' as const });
const zeeraa = () => ({ tenantId: fx.tenantA, userId: fx.zeeraaAdmin, role: 'zeeraa_admin' as const });

describe('a client admin, calling the database directly', () => {
  it('cannot grant access to anybody, at any role', async () => {
    for (const role of ['client_viewer', 'client_admin', 'zeeraa_member', 'zeeraa_admin'] as const) {
      const error = await failure(() =>
        withTenant(
          ctx(),
          (tx) => tx.insert(schema.memberships).values({ userId: outsiderId, tenantId: fx.tenantA, role }),
          app.db,
        ),
      );
      expect(error.code).toBe('42501');
    }
  });

  it('cannot remove anybody — a client member or a Zeeraa admin', async () => {
    for (const target of [fx.zeeraaAdmin, fx.zeeraaAdminAOnly]) {
      const removed = await withTenant(
        ctx(),
        (tx) =>
          tx
            .delete(schema.memberships)
            .where(and(eq(schema.memberships.userId, target), eq(schema.memberships.tenantId, fx.tenantA)))
            .returning(),
        app.db,
      );
      expect(removed).toHaveLength(0);
    }
    const survivors = await asOwner(owner.db, (tx) =>
      tx.select().from(schema.memberships).where(eq(schema.memberships.tenantId, fx.tenantA)),
    );
    expect(survivors.map((m) => m.userId)).toEqual(
      expect.arrayContaining([fx.zeeraaAdmin, fx.zeeraaAdminAOnly]),
    );
  });

  it("cannot reset a Zeeraa admin's password — the escalation 0027 closes", async () => {
    const rows = await withTenant(
      ctx(),
      (tx) =>
        tx
          .update(schema.users)
          .set({ passwordHash: 'attacker-chosen', mustChangePassword: true })
          .where(eq(schema.users.id, fx.zeeraaAdmin))
          .returning({ id: schema.users.id }),
      app.db,
    );
    expect(rows).toHaveLength(0);
    const [victim] = await asOwner(owner.db, (tx) =>
      tx.select({ hash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, fx.zeeraaAdmin)),
    );
    expect(victim?.hash).not.toBe('attacker-chosen');
  });

  it('cannot create an account', async () => {
    const error = await failure(() =>
      withTenant(
        ctx(),
        (tx) => tx.insert(schema.users).values({ email: `ca-made-${Date.now()}@example.test`, name: 'No' }),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');
  });

  it('cannot look up an account attached to no engagement', async () => {
    const visible = await withTenant(
      ctx(),
      (tx) => tx.select().from(schema.users).where(eq(schema.users.id, outsiderId)),
      app.db,
    );
    expect(visible).toHaveLength(0);
  });
});

describe('a Zeeraa admin', () => {
  it('may grant access at any role, and remove it again', async () => {
    const rows = await withTenant(
      zeeraa(),
      (tx) =>
        tx
          .insert(schema.memberships)
          .values({ userId: outsiderId, tenantId: fx.tenantA, role: 'client_viewer' })
          .returning({ id: schema.memberships.id }),
      app.db,
    );
    expect(rows).toHaveLength(1);
    const removed = await withTenant(
      zeeraa(),
      (tx) =>
        tx
          .delete(schema.memberships)
          .where(and(eq(schema.memberships.userId, outsiderId), eq(schema.memberships.tenantId, fx.tenantA)))
          .returning(),
      app.db,
    );
    expect(removed).toHaveLength(1);
  });

  it('may not grant access to a tenant other than the one in context', async () => {
    const error = await failure(() =>
      withTenant(
        zeeraa(),
        (tx) =>
          tx.insert(schema.memberships).values({ userId: outsiderId, tenantId: fx.tenantB, role: 'client_viewer' }),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');
  });

  it('may reset a password in the tenant, and not outside it', async () => {
    const inside = await withTenant(
      zeeraa(),
      (tx) =>
        tx
          .update(schema.users)
          .set({ mustChangePassword: true })
          .where(eq(schema.users.id, fx.clientAdminA))
          .returning({ id: schema.users.id }),
      app.db,
    );
    expect(inside).toHaveLength(1);
    const outside = await withTenant(
      zeeraa(),
      (tx) =>
        tx
          .update(schema.users)
          .set({ passwordHash: 'attacker-chosen' })
          .where(eq(schema.users.id, fx.clientViewerB))
          .returning({ id: schema.users.id }),
      app.db,
    );
    expect(outside).toHaveLength(0);
  });

  it('may create an account, and see it before it has any membership', async () => {
    const email = `za-made-${Date.now()}@example.test`;
    await withTenant(zeeraa(), (tx) => tx.insert(schema.users).values({ email, name: 'Made' }), app.db);
    const [row] = await asOwner(owner.db, (tx) =>
      tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)),
    );
    expect(row).toBeDefined();
    const visible = await withTenant(
      zeeraa(),
      (tx) => tx.select().from(schema.users).where(eq(schema.users.id, row!.id)),
      app.db,
    );
    expect(visible).toHaveLength(1);
    await asOwner(owner.db, (tx) => tx.delete(schema.users).where(eq(schema.users.id, row!.id)));
  });

  it("sees an unattached account but not another engagement's roster", async () => {
    const all = await withTenant(zeeraa(), (tx) => tx.select().from(schema.users), app.db);
    const ids = all.map((u) => u.id);
    expect(ids).toContain(outsiderId);
    expect(ids).not.toContain(fx.clientViewerB);
  });
});

describe('the last Zeeraa admin of a tenant', () => {
  // Tenant B's only Zeeraa admin is `fx.zeeraaAdmin`; tenant A has two.
  const ctxB = () => ({ tenantId: fx.tenantB, userId: fx.zeeraaAdmin, role: 'zeeraa_admin' as const });

  it('cannot have their membership removed, by anybody', async () => {
    const error = await failure(() =>
      withTenant(
        ctxB(),
        (tx) =>
          tx
            .delete(schema.memberships)
            .where(and(eq(schema.memberships.userId, fx.zeeraaAdmin), eq(schema.memberships.tenantId, fx.tenantB))),
        app.db,
      ),
    );
    expect(error.message).toMatch(/last Zeeraa admin/);

    // Not by a maintenance session either: this is a trigger, not a policy.
    const maint = await failure(() =>
      asOwner(owner.db, (tx) =>
        tx
          .delete(schema.memberships)
          .where(and(eq(schema.memberships.userId, fx.zeeraaAdmin), eq(schema.memberships.tenantId, fx.tenantB))),
      ),
    );
    expect(maint.message).toMatch(/last Zeeraa admin/);
  });

  it('cannot be deleted as an account', async () => {
    const error = await failure(() =>
      asOwner(owner.db, (tx) => tx.delete(schema.users).where(eq(schema.users.id, fx.zeeraaAdmin))),
    );
    expect(error.message).toMatch(/last Zeeraa admin/);
  });

  it('can be removed where another Zeeraa admin remains', async () => {
    // Tenant A keeps `zeeraaAdminAOnly`. Removed and restored.
    const removed = await withTenant(
      zeeraa(),
      (tx) =>
        tx
          .delete(schema.memberships)
          .where(and(eq(schema.memberships.userId, fx.zeeraaAdmin), eq(schema.memberships.tenantId, fx.tenantA)))
          .returning(),
      app.db,
    );
    expect(removed).toHaveLength(1);
    await asOwner(owner.db, (tx) =>
      tx.insert(schema.memberships).values({ userId: fx.zeeraaAdmin, tenantId: fx.tenantA, role: 'zeeraa_admin' }),
    );
  });

  it('refuses a single statement that removes every Zeeraa admin at once', async () => {
    const error = await failure(() =>
      asOwner(owner.db, (tx) =>
        tx
          .delete(schema.memberships)
          .where(and(eq(schema.memberships.tenantId, fx.tenantA), eq(schema.memberships.role, 'zeeraa_admin'))),
      ),
    );
    expect(error.message).toMatch(/last Zeeraa admin/);
    const left = await asOwner(owner.db, (tx) =>
      tx
        .select()
        .from(schema.memberships)
        .where(and(eq(schema.memberships.tenantId, fx.tenantA), eq(schema.memberships.role, 'zeeraa_admin'))),
    );
    expect(left).toHaveLength(2);
  });
});

describe('a client viewer', () => {
  it('cannot grant access to anybody', async () => {
    const error = await failure(() =>
      withTenant(
        { tenantId: fx.tenantB, userId: fx.clientViewerB, role: 'client_viewer' },
        (tx) =>
          tx
            .insert(schema.memberships)
            .values({ userId: outsiderId, tenantId: fx.tenantB, role: 'client_viewer' }),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');
  });
});

describe('self-promotion through the membership row', () => {
  it('is refused: role is not a column the application may update', async () => {
    // `memberships_update_own` admits an update of your own row so that you can
    // change your own notification preferences. Before 0017 that included
    // `role`, and `app.membership_index` is maintained from this table, so the
    // promotion would have taken effect immediately.
    const error = await failure(() =>
      withTenant(
        ctx(),
        (tx) =>
          tx
            .update(schema.memberships)
            .set({ role: 'zeeraa_admin' })
            .where(eq(schema.memberships.userId, fx.clientAdminA)),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');

    const [row] = await asOwner(owner.db, (tx) =>
      tx
        .select({ role: schema.memberships.role })
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.userId, fx.clientAdminA),
            eq(schema.memberships.tenantId, fx.tenantA),
          ),
        ),
    );
    expect(row?.role).toBe('client_admin');
  });

  it('still allows the preference update the policy exists for', async () => {
    const rows = await withTenant(
      ctx(),
      (tx) =>
        tx
          .update(schema.memberships)
          .set({ emailPreference: 'digest' })
          .where(eq(schema.memberships.userId, fx.clientAdminA))
          .returning({ pref: schema.memberships.emailPreference }),
      app.db,
    );
    expect(rows[0]?.pref).toBe('digest');
  });
});

describe('the session store', () => {
  it('is unreachable from the application role', async () => {
    // Sessions are bearer credentials. The application role has no grant on the
    // table at all — only zeeraa_auth does, and only before a tenant exists.
    const error = await failure(() =>
      withUserOnly(fx.clientAdminA, (tx) => tx.select().from(schema.sessions), app.db),
    );
    expect(error.code).toBe('42501');
  });
});
