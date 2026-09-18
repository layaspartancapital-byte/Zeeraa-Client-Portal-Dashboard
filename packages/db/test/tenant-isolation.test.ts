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

describe('calls', () => {
  /*
   * Calls hold two kinds of PII — a merchant's phone number and an agent's
   * name — and the join key is the phone number itself, so a leak here would
   * also tell one client whom another is calling and how often.
   */
  it('are readable inside the tenant that owns them', async () => {
    const rows = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) => tx.select().from(schema.calls),
      app.db,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe('A-CALL-1');
  });

  it('do not leak another tenant’s numbers from an unfiltered query', async () => {
    const rows = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) => tx.select().from(schema.calls),
      app.db,
    );
    expect(rows.map((r) => r.contactKey)).not.toContain('4155550222');
    expect(rows.map((r) => r.agentName)).not.toContain('Rep B');
  });

  it('cannot be written into another tenant', async () => {
    // The webhook is the reason this matters: it takes a tenant from the URL
    // and a payload from a third party.
    await expect(
      withTenant(
        { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
        (tx) =>
          tx.insert(schema.calls).values({
            tenantId: fx.tenantB,
            externalId: 'X-CALL-1',
            occurredAt: new Date('2026-08-02T12:00:00Z'),
            direction: 'outbound',
            outcome: 'attempted',
            source: 'webhook',
          }),
        app.db,
      ),
    ).rejects.toThrow();
  });
});

describe('lender submissions', () => {
  /*
   * The newest tenant-scoped table, tested at both ends.
   *
   * A submission holds a third party's decision about a client's merchant, so
   * the leak it would permit is worse than most: tenant A would learn which
   * lenders tenant B submits to and what they decline. Both directions are
   * asserted, because a policy that reads nothing for anybody is as broken as
   * one that reads everything — and only the first of those is caught by a
   * test that checks the leak alone.
   */
  it('are readable inside the tenant that owns them', async () => {
    const rows = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) => tx.select().from(schema.submissions),
      app.db,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe('A-SUB-1');
    expect(rows[0]?.lenderName).toBe('Lender A');
  });

  it('do not leak another tenant’s lenders from an unfiltered query', async () => {
    const rows = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      // Again the forgotten filter, which is the whole point of the policy.
      (tx) => tx.select().from(schema.submissions),
      app.db,
    );
    expect(rows.map((r) => r.lenderName)).not.toContain('Lender B');
  });

  it('cannot be written into another tenant', async () => {
    await expect(
      withTenant(
        { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
        (tx) =>
          tx.insert(schema.submissions).values({
            tenantId: fx.tenantB,
            externalId: 'X-SUB-1',
            opportunityExternalId: 'B-OPP-1',
            outcome: 'offered',
            submittedAt: new Date('2026-08-02T12:00:00Z'),
          }),
        app.db,
      ),
    ).rejects.toThrow();
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

    const stillInA = await asOwner(owner.db, (tx) =>
      tx
        .select()
        .from(schema.opportunities)
        .where(
          and(
            eq(schema.opportunities.externalId, 'A-OPP-1'),
            eq(schema.opportunities.tenantId, fx.tenantA),
          ),
        ),
    );
    expect(stillInA).toHaveLength(1);
  });

  it('cannot delete another tenant’s rows', async () => {
    const deleted = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) => tx.delete(schema.dailyMetrics).returning(),
      app.db,
    );
    expect(deleted.every((r) => r.tenantId === fx.tenantA)).toBe(true);
    const survivors = await asOwner(owner.db, (tx) =>
      tx.select().from(schema.dailyMetrics).where(eq(schema.dailyMetrics.tenantId, fx.tenantB)),
    );
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
    expect(visible.map((u) => u.id).sort()).toEqual(
      [fx.clientAdminA, fx.zeeraaAdmin, fx.zeeraaAdminAOnly].sort(),
    );
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

/**
 * The Zeeraa admin cross-tenant path.
 *
 * This used to be a second policy path: `has_tenant_access()` returned true for
 * anyone holding `zeeraa_admin` in any tenant at all, so one admin membership
 * anywhere granted every client in the system. It left no row to audit and
 * nothing to revoke — you could not answer "who can read this client?" from the
 * database. Access now requires a membership row per tenant, so the answer is
 * always a query against `memberships`.
 */
describe('a Zeeraa admin holding one membership', () => {
  const ctxFor = (tenantId: string) => ({
    tenantId,
    userId: fx.zeeraaAdminAOnly,
    role: 'zeeraa_admin' as const,
  });

  it('reads the tenant it is a member of', async () => {
    const rows = await withTenant(ctxFor(fx.tenantA), (tx) =>
      tx.select().from(schema.opportunities), app.db);
    expect(rows.map((r) => r.externalId)).toEqual(['A-OPP-1']);
  });

  it('reads nothing in a tenant it has no membership row for', async () => {
    const rows = await withTenant(ctxFor(fx.tenantB), (tx) =>
      tx.select().from(schema.opportunities), app.db);
    expect(rows).toHaveLength(0);
  });

  it('cannot write into a tenant it has no membership row for', async () => {
    const error = await failure(() =>
      withTenant(
        ctxFor(fx.tenantB),
        (tx) =>
          tx.insert(schema.opportunities).values({
            tenantId: fx.tenantB,
            externalId: 'ADMIN-SNEAK',
            createdAt: new Date(),
            currentStage: 'lead',
          }),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');
  });

  it('cannot grant itself one, because the write policy asks the same question', async () => {
    const error = await failure(() =>
      withTenant(
        ctxFor(fx.tenantB),
        (tx) =>
          tx.insert(schema.memberships).values({
            userId: fx.zeeraaAdminAOnly,
            tenantId: fx.tenantB,
            role: 'zeeraa_admin',
          }),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');
  });

  it('holds no effective role in a tenant it is not a member of', async () => {
    const rows = await withTenant(ctxFor(fx.tenantB), (tx) =>
      tx.execute<{ role: string | null }>(sql`select app.effective_role() as role`), app.db);
    expect(rows[0]?.role).toBeNull();
  });

  it('is not offered that tenant in the switcher', async () => {
    const rows = await withUserOnly(
      fx.zeeraaAdminAOnly,
      (tx) => tx.select({ id: schema.tenants.id }).from(schema.tenants),
      app.db,
    );
    expect(rows.map((r) => r.id)).toEqual([fx.tenantA]);
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
      asOwner(owner.db, (tx) =>
        tx
          .insert(schema.memberships)
          .values({ userId: fx.clientAdminA, tenantId: fx.tenantB, role: 'client_viewer' }),
      ),
    );
    expect(error.code).toBe('23514');
    expect(error.message).toMatch(/exactly one tenant/i);
  });

  it('allows a role change in place, so a re-run of the seed is not a violation', async () => {
    const row = await asOwner(owner.db, async (tx) => {
      await tx
        .insert(schema.memberships)
        .values({ userId: fx.clientAdminA, tenantId: fx.tenantA, role: 'client_admin' })
        .onConflictDoUpdate({
          target: [schema.memberships.userId, schema.memberships.tenantId],
          set: { role: 'client_viewer' },
        });
      const [found] = await tx
        .select()
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.userId, fx.clientAdminA),
            eq(schema.memberships.tenantId, fx.tenantA),
          ),
        );
      return found;
    });
    expect(row?.role).toBe('client_viewer');
    await asOwner(owner.db, (tx) =>
      tx
        .update(schema.memberships)
        .set({ role: 'client_admin' })
        .where(eq(schema.memberships.id, row!.id)),
    );
  });

  it('refuses to give a client-role user a Zeeraa role elsewhere', async () => {
    const error = await failure(() =>
      asOwner(owner.db, (tx) =>
        tx
          .insert(schema.memberships)
          .values({ userId: fx.clientAdminA, tenantId: fx.tenantB, role: 'zeeraa_member' }),
      ),
    );
    expect(error.code).toBe('23514');
    expect(error.message).toMatch(/already holds a client role/i);
  });
});

describe('membership cardinality, through the application', () => {
  it('refuses to attach another tenant\u2019s client user, though that row is invisible here', async () => {
    // The trigger has to see a membership in tenant B while the caller is
    // scoped to tenant A. As an invoker-rights function it could not, and this
    // insert succeeded — handing the tenant B user a second membership and a
    // read on tenant A. It is SECURITY DEFINER now.
    const error = await failure(() =>
      withTenant(
        { tenantId: fx.tenantA, userId: fx.zeeraaAdmin, role: 'zeeraa_admin' },
        (tx) =>
          tx.insert(schema.memberships).values({
            userId: fx.clientViewerB,
            tenantId: fx.tenantA,
            role: 'client_viewer',
          }),
        app.db,
      ),
    );
    expect(error.code).toBe('23514');
    expect(error.message).toMatch(/exactly one tenant/i);

    const held = await asOwner(owner.db, (tx) =>
      tx.select().from(schema.memberships).where(eq(schema.memberships.userId, fx.clientViewerB)),
    );
    expect(held).toHaveLength(1);
    expect(held[0]?.tenantId).toBe(fx.tenantB);
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

  it('isolates blocked_dependencies, which carries client-readable prose', async () => {
    // A blocked dependency's `reason` and `evidence` quote the client's own
    // field-population figures, so a leak here is a leak of one lender's
    // operational detail into another's screen.
    await asOwner(owner.db, (tx) =>
      tx.insert(schema.blockedDependencies).values([
        {
          tenantId: fx.tenantA,
          key: 'mql_stage',
          subjectKind: 'funnel_stage',
          subjectKey: 'mql',
          label: 'MQL',
          reason: 'A-only reason',
        },
        {
          tenantId: fx.tenantB,
          key: 'mql_stage',
          subjectKind: 'funnel_stage',
          subjectKey: 'mql',
          label: 'MQL',
          reason: 'B-only reason',
        },
      ]),
    );

    // The query an application developer writes on a bad day: no tenant filter.
    const seen = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) => tx.select().from(schema.blockedDependencies),
      app.db,
    );
    expect(seen.map((r) => r.reason)).toEqual(['A-only reason']);

    // And naming tenant B explicitly returns nothing rather than erroring,
    // because the policy is a filter and not a permission check.
    const crossed = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) =>
        tx
          .select()
          .from(schema.blockedDependencies)
          .where(eq(schema.blockedDependencies.tenantId, fx.tenantB)),
      app.db,
    );
    expect(crossed).toEqual([]);
  });

  it('refuses a subject_kind the UI does not know how to render', async () => {
    // The funnel view switches on this value. An unrecognised one would render
    // as nothing at all, which is the silent gap the whole mechanism exists to
    // prevent, so the constraint is in the database rather than in a validator.
    const error = await failure(() =>
      asOwner(owner.db, (tx) =>
        tx.insert(schema.blockedDependencies).values({
          tenantId: fx.tenantA,
          key: 'nonsense',
          subjectKind: 'wall_chart',
          subjectKey: 'x',
          label: 'x',
          reason: 'x',
        }),
      ),
    );
    expect(error.code).toBe('23514');
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
