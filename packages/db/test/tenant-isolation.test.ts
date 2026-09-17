/**
 * The test §5 requires before phase 3.
 *
 * Each case deliberately writes the query an application developer would write
 * on a bad day — no tenant filter at all, or the wrong tenant id supplied on
 * purpose — and asserts the database returns nothing. If any of these ever
 * returns a row, one lender is reading another lender's funded volume.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, withUserOnly } from '../src/tenant-context';
import * as schema from '../src/schema/index';
import {
  appClient,
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
});

afterAll(async () => {
  await cleanup(owner.db, fx);
  await owner.client.end();
  await app.client.end();
});

describe('the runtime role', () => {
  it('cannot bypass row level security', async () => {
    const rows = await app.db.execute<{ bypass: boolean; super: boolean }>(sql`
      select rolbypassrls as bypass, rolsuper as super
      from pg_roles where rolname = current_user
    `);
    expect(rows[0]?.bypass).toBe(false);
    expect(rows[0]?.super).toBe(false);
  });

  it('sees nothing at all outside a tenant context', async () => {
    // No withTenant wrapper: app.current_tenant_id() is null, so every policy
    // is false. The cost of forgetting the wrapper is an empty screen.
    const rows = await app.db.select().from(schema.opportunities);
    expect(rows).toHaveLength(0);
  });
});

describe('a client admin in tenant A', () => {
  it('reads only tenant A rows from an unfiltered query', async () => {
    const rows = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      // Note the missing `where tenant_id = ...`. This is the forgotten filter.
      (tx) => tx.select().from(schema.opportunities),
      app.db,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe('A-OPP-1');
  });

  it('reads zero rows when it names tenant B explicitly', async () => {
    const rows = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) =>
        tx.select().from(schema.opportunities).where(eq(schema.opportunities.tenantId, fx.tenantB)),
      app.db,
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot read tenant B by asking to be in tenant B', async () => {
    // The request asserts a tenant it has no membership in. has_tenant_access()
    // consults the membership table, not the request, so the answer is nothing.
    const rows = await withTenant(
      { tenantId: fx.tenantB, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) => tx.select().from(schema.opportunities),
      app.db,
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot read tenant B by claiming to be a Zeeraa admin', async () => {
    // Role escalation attempted through the session claim. Policies read the
    // membership row, so the claim buys nothing.
    const rows = await withTenant(
      { tenantId: fx.tenantB, userId: fx.clientAdminA, role: 'zeeraa_admin' },
      (tx) => tx.select().from(schema.dailyMetrics),
      app.db,
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot write a row into tenant B', async () => {
    const error = await failure(() =>
      withTenant(
        { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
        (tx) =>
          tx.insert(schema.opportunities).values({
            tenantId: fx.tenantB,
            externalId: 'SMUGGLED',
            createdAt: new Date(),
            currentStage: 'lead',
          }),
        app.db,
      ),
    );
    // 42501: insufficient privilege — the WITH CHECK clause refused the row.
    expect(error.code).toBe('42501');
  });

  it('cannot move an existing row into tenant B', async () => {
    const error = await failure(() =>
      withTenant(
        { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
        (tx) =>
          tx
            .update(schema.opportunities)
            .set({ tenantId: fx.tenantB })
            .where(eq(schema.opportunities.externalId, 'A-OPP-1'))
            .returning(),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');

    const stillInA = await owner.db
      .select()
      .from(schema.opportunities)
      .where(eq(schema.opportunities.externalId, 'A-OPP-1'));
    expect(stillInA[0]?.tenantId).toBe(fx.tenantA);
  });

  it('cannot delete another tenant’s rows', async () => {
    const deleted = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) => tx.delete(schema.dailyMetrics).returning(),
      app.db,
    );
    expect(deleted.every((r) => r.tenantId === fx.tenantA)).toBe(true);
    const survivors = await owner.db
      .select()
      .from(schema.dailyMetrics)
      .where(eq(schema.dailyMetrics.tenantId, fx.tenantB));
    expect(survivors).toHaveLength(1);
  });
});

describe('the mention picker boundary', () => {
  it('never surfaces a user from another tenant', async () => {
    const visible = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) =>
        tx
          .select({ id: schema.users.id, email: schema.users.email })
          .from(schema.users)
          .innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id)),
      app.db,
    );
    expect(visible.map((u) => u.id).sort()).toEqual([fx.clientAdminA, fx.zeeraaAdmin].sort());
    expect(visible.some((u) => u.id === fx.clientViewerB)).toBe(false);
  });

  it('cannot reach another tenant’s user even by selecting the users table directly', async () => {
    const rows = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) => tx.select().from(schema.users).where(eq(schema.users.id, fx.clientViewerB)),
      app.db,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('the tenant switcher', () => {
  it('shows a client user exactly one tenant', async () => {
    const rows = await withUserOnly(
      fx.clientAdminA,
      (tx) => tx.select({ id: schema.tenants.id, name: schema.tenants.name }).from(schema.tenants),
      app.db,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(fx.tenantA);
  });
});

describe('a Zeeraa admin', () => {
  it('reads each tenant separately, never both at once', async () => {
    const inA = await withTenant(
      { tenantId: fx.tenantA, userId: fx.zeeraaAdmin, role: 'zeeraa_admin' },
      (tx) => tx.select().from(schema.opportunities),
      app.db,
    );
    const inB = await withTenant(
      { tenantId: fx.tenantB, userId: fx.zeeraaAdmin, role: 'zeeraa_admin' },
      (tx) => tx.select().from(schema.opportunities),
      app.db,
    );
    expect(inA.map((r) => r.externalId)).toEqual(['A-OPP-1']);
    expect(inB.map((r) => r.externalId)).toEqual(['B-OPP-1']);
  });

  it('lists its own memberships for the switcher without any tenant set', async () => {
    const rows = await withUserOnly(
      fx.zeeraaAdmin,
      (tx) =>
        tx.select().from(schema.memberships).where(eq(schema.memberships.userId, fx.zeeraaAdmin)),
      app.db,
    );
    expect(rows.map((r) => r.tenantId).sort()).toEqual([fx.tenantA, fx.tenantB].sort());
  });

  it('names its own tenants for the switcher, and no others', async () => {
    const rows = await withUserOnly(
      fx.zeeraaAdmin,
      (tx) => tx.select({ id: schema.tenants.id }).from(schema.tenants),
      app.db,
    );
    expect(rows.map((r) => r.id).sort()).toEqual([fx.tenantA, fx.tenantB].sort());
  });

  it('still reads no tenant data with only a user set', async () => {
    const rows = await withUserOnly(
      fx.zeeraaAdmin,
      (tx) => tx.select().from(schema.opportunities),
      app.db,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('the audit trail', () => {
  it('rejects updates and deletes on activity_log', async () => {
    const ctx = { tenantId: fx.tenantA, userId: fx.zeeraaAdmin, role: 'zeeraa_admin' as const };
    await withTenant(
      ctx,
      (tx) =>
        tx.insert(schema.activityLog).values({
          tenantId: fx.tenantA,
          actorUserId: fx.zeeraaAdmin,
          verb: 'tested',
          objectType: 'test',
        }),
      app.db,
    );

    const updated = await withTenant(
      ctx,
      (tx) =>
        tx
          .update(schema.activityLog)
          .set({ verb: 'rewrote history' })
          .where(eq(schema.activityLog.tenantId, fx.tenantA))
          .returning(),
      app.db,
    );
    expect(updated).toHaveLength(0);

    const deleted = await withTenant(
      ctx,
      (tx) => tx.delete(schema.activityLog).returning(),
      app.db,
    );
    expect(deleted).toHaveLength(0);
  });
});

describe('membership cardinality', () => {
  it('refuses to attach a client-role user to a second tenant', async () => {
    const error = await failure(() =>
      owner.db
        .insert(schema.memberships)
        .values({ userId: fx.clientAdminA, tenantId: fx.tenantB, role: 'client_viewer' }),
    );
    expect(error.code).toBe('23514');
    expect(error.message).toMatch(/exactly one tenant/i);
  });

  it('allows a role change in place, so a re-run of the seed is not a violation', async () => {
    await owner.db
      .insert(schema.memberships)
      .values({ userId: fx.clientAdminA, tenantId: fx.tenantA, role: 'client_admin' })
      .onConflictDoUpdate({
        target: [schema.memberships.userId, schema.memberships.tenantId],
        set: { role: 'client_viewer' },
      });
    const [row] = await owner.db
      .select()
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.userId, fx.clientAdminA),
          eq(schema.memberships.tenantId, fx.tenantA),
        ),
      );
    expect(row?.role).toBe('client_viewer');
    await owner.db
      .update(schema.memberships)
      .set({ role: 'client_admin' })
      .where(eq(schema.memberships.id, row!.id));
  });

  it('refuses to give a client-role user a Zeeraa role elsewhere', async () => {
    const error = await failure(() =>
      owner.db
        .insert(schema.memberships)
        .values({ userId: fx.clientAdminA, tenantId: fx.tenantB, role: 'zeeraa_member' }),
    );
    expect(error.code).toBe('23514');
    expect(error.message).toMatch(/already holds a client role/i);
  });
});

describe('schema-wide guarantees', () => {
  it('leaves no table in public without row level security', async () => {
    const rows = await owner.db.execute<{ relname: string }>(sql`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
        and c.relname <> '__drizzle_migrations'
    `);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('gives every tenant-scoped table a policy', async () => {
    const rows = await owner.db.execute<{ relname: string }>(sql`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0
      where n.nspname = 'public' and c.relkind = 'r'
        and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
    `);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});
