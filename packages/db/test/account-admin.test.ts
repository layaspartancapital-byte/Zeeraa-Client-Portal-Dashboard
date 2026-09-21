/**
 * The policies behind account administration (migration 0017).
 *
 * Three things have to hold, and the application cannot be what makes them
 * hold — the role checks in `lib/users.ts` produce a readable error and are
 * deleted by any attacker who is not using the application:
 *
 *   1. a client admin may add people to their own engagement and to no other;
 *   2. a client admin may not mint a Zeeraa role, which would escape the tenant;
 *   3. nobody may promote themselves by updating their own membership row.
 *
 * Every assertion is scoped to the fixture's own tenants: these run against the
 * same Postgres as every other suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
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

describe('a client admin granting access', () => {
  it('may add somebody to their own tenant as a client role', async () => {
    const rows = await withTenant(
      ctx(),
      (tx) =>
        tx
          .insert(schema.memberships)
          .values({ userId: outsiderId, tenantId: fx.tenantA, role: 'client_viewer' })
          .returning({ id: schema.memberships.id }),
      app.db,
    );
    expect(rows).toHaveLength(1);

    await asOwner(owner.db, (tx) =>
      tx
        .delete(schema.memberships)
        .where(
          and(
            eq(schema.memberships.userId, outsiderId),
            eq(schema.memberships.tenantId, fx.tenantA),
          ),
        ),
    );
  });

  it('may not mint a Zeeraa role, which would escape the tenant', async () => {
    // The escalation this policy exists to stop: zeeraa_member is a role
    // `canSwitchTenant` lets out of this engagement entirely, so a client admin
    // able to grant one could read every other client in the system.
    for (const role of ['zeeraa_admin', 'zeeraa_member'] as const) {
      const error = await failure(() =>
        withTenant(
          ctx(),
          (tx) =>
            tx
              .insert(schema.memberships)
              .values({ userId: outsiderId, tenantId: fx.tenantA, role }),
          app.db,
        ),
      );
      expect(error.code).toBe('42501');
    }
  });

  it('may not add anybody to another tenant', async () => {
    const error = await failure(() =>
      withTenant(
        ctx(),
        (tx) =>
          tx
            .insert(schema.memberships)
            .values({ userId: outsiderId, tenantId: fx.tenantB, role: 'client_viewer' }),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');
  });

  it('may not remove somebody from another tenant', async () => {
    const removed = await withTenant(
      ctx(),
      (tx) =>
        tx
          .delete(schema.memberships)
          .where(eq(schema.memberships.tenantId, fx.tenantB))
          .returning(),
      app.db,
    );
    expect(removed).toHaveLength(0);

    // And tenant B still has its people.
    const survivors = await asOwner(owner.db, (tx) =>
      tx.select().from(schema.memberships).where(eq(schema.memberships.tenantId, fx.tenantB)),
    );
    expect(survivors.length).toBeGreaterThan(0);
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

describe('creating an account', () => {
  const created: string[] = [];
  afterAll(async () => {
    if (created.length > 0) {
      await asOwner(owner.db, (tx) =>
        tx.delete(schema.users).where(inArray(schema.users.id, created)),
      );
    }
  });

  it('is permitted to an admin and refused to a viewer', async () => {
    const email = `made-${Date.now()}@example.test`;
    await withTenant(
      ctx(),
      (tx) => tx.insert(schema.users).values({ email, name: 'Made By Admin' }),
      app.db,
    );
    const [row] = await asOwner(owner.db, (tx) =>
      tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)),
    );
    expect(row).toBeDefined();
    created.push(row!.id);

    const error = await failure(() =>
      withTenant(
        { tenantId: fx.tenantB, userId: fx.clientViewerB, role: 'client_viewer' },
        (tx) =>
          tx
            .insert(schema.users)
            .values({ email: `denied-${Date.now()}@example.test`, name: 'Denied' }),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');
  });

  it('is visible to the admin who created it, before any membership', async () => {
    // This used to assert the opposite, and the opposite was the bug: an
    // account sharing no tenant with anybody was invisible to every admin, so
    // removing a membership made the person unreachable. 0019 admits exactly
    // this case. See "an account attached to no engagement" below.
    //
    // `createUser` still generates the id rather than relying on RETURNING.
    // Nothing forces that now, but it also does not depend on a policy staying
    // permissive to be able to finish an insert it already made.
    const visible = await withTenant(
      ctx(),
      (tx) => tx.select().from(schema.users).where(eq(schema.users.id, outsiderId)),
      app.db,
    );
    expect(visible).toHaveLength(1);
  });
});

describe('an account attached to no engagement', () => {
  /**
   * The deadlock reported on 21 September 2026. Remove somebody's membership
   * and they became unreachable: "create" refused because `users_email_key` is
   * global, and "add existing" refused because the lookup could not see a user
   * who shares no tenant with anybody.
   */
  it('is visible to an admin, so their access can be granted again', async () => {
    const visible = await withTenant(
      ctx(),
      (tx) =>
        tx
          .select({ id: schema.users.id, email: schema.users.email })
          .from(schema.users)
          .where(eq(schema.users.id, outsiderId)),
      app.db,
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]?.email).toBe(outsiderEmail);
  });

  it('can then actually be granted access, which is the point', async () => {
    const rows = await withTenant(
      ctx(),
      (tx) =>
        tx
          .insert(schema.memberships)
          .values({ userId: outsiderId, tenantId: fx.tenantA, role: 'client_viewer' })
          .returning({ id: schema.memberships.id }),
      app.db,
    );
    expect(rows).toHaveLength(1);

    // And once attached it is no longer "unattached" — the row is now visible
    // because it shares the tenant, not because of the new policy.
    await asOwner(owner.db, (tx) =>
      tx
        .delete(schema.memberships)
        .where(
          and(
            eq(schema.memberships.userId, outsiderId),
            eq(schema.memberships.tenantId, fx.tenantA),
          ),
        ),
    );
  });

  it('is not visible to a client viewer, who administers nobody', async () => {
    const visible = await withTenant(
      { tenantId: fx.tenantB, userId: fx.clientViewerB, role: 'client_viewer' },
      (tx) => tx.select().from(schema.users).where(eq(schema.users.id, outsiderId)),
      app.db,
    );
    expect(visible).toHaveLength(0);
  });

  it('does not drag another engagement\'s roster into view with it', async () => {
    // The whole risk of this policy. `clientViewerB` holds a membership in
    // tenant B only, so from tenant A they must stay hidden — the helper reads
    // `app.membership_index` as definer precisely so a membership the caller
    // cannot see still counts.
    const visible = await withTenant(
      ctx(),
      (tx) => tx.select().from(schema.users).where(eq(schema.users.id, fx.clientViewerB)),
      app.db,
    );
    expect(visible).toHaveLength(0);
  });

  it('does not let an admin enumerate every user in the system', async () => {
    const all = await withTenant(ctx(), (tx) => tx.select().from(schema.users), app.db);
    const ids = all.map((u) => u.id);
    // Their own tenant's people, plus the unattached account. Not tenant B's.
    expect(ids).toContain(fx.clientAdminA);
    expect(ids).toContain(outsiderId);
    expect(ids).not.toContain(fx.clientViewerB);
  });
});

describe('resetting a password', () => {
  it('reaches somebody in the tenant', async () => {
    const rows = await withTenant(
      ctx(),
      (tx) =>
        tx
          .update(schema.users)
          .set({ passwordHash: 'x', mustChangePassword: true })
          .where(eq(schema.users.id, fx.zeeraaAdmin))
          .returning({ id: schema.users.id }),
      app.db,
    );
    expect(rows).toHaveLength(1);
  });

  it('cannot reach somebody outside it', async () => {
    const rows = await withTenant(
      ctx(),
      (tx) =>
        tx
          .update(schema.users)
          .set({ passwordHash: 'attacker-chosen' })
          .where(eq(schema.users.id, fx.clientViewerB))
          .returning({ id: schema.users.id }),
      app.db,
    );
    expect(rows).toHaveLength(0);

    const [victim] = await asOwner(owner.db, (tx) =>
      tx
        .select({ hash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.id, fx.clientViewerB)),
    );
    expect(victim?.hash).toBeNull();
  });

  it('cannot reach an account that belongs to no tenant', async () => {
    const rows = await withTenant(
      ctx(),
      (tx) =>
        tx
          .update(schema.users)
          .set({ passwordHash: 'attacker-chosen' })
          .where(eq(schema.users.id, outsiderId))
          .returning({ id: schema.users.id }),
      app.db,
    );
    expect(rows).toHaveLength(0);
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
