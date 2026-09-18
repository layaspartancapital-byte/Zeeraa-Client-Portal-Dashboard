/**
 * FORCE ROW LEVEL SECURITY, and the door it leaves.
 *
 * FORCE binds the role that owns the tables, which is what brings a backfill
 * script or a psql session inside the model rather than around it. Because that
 * would otherwise make seeding impossible, membership of `zeeraa_maintenance`
 * plus an explicit `app.maintenance` flag opens a door — per transaction, and
 * greppable.
 *
 * One thing FORCE cannot do: a superuser bypasses row level security whatever
 * is set. That is exactly why migrations and seeds run as `zeeraa_owner`
 * (NOSUPERUSER, NOBYPASSRLS) rather than as `postgres` — otherwise these tests
 * would pass for a reason that does not hold in production.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import * as schema from '../src/schema';
import { withMaintenance, withTenant } from '../src/tenant-context';
import {
  appClient,
  asOwner,
  cleanup,
  maintClient,
  ownerClient,
  seedTwoTenants,
  type Fixture,
} from './fixtures';

const owner = ownerClient();
const maint = maintClient();
const app = appClient();
let fx: Fixture;

beforeAll(async () => {
  fx = await seedTwoTenants(owner.db);
});

afterAll(async () => {
  await cleanup(owner.db, fx);
  await Promise.all([owner.client.end(), maint.client.end(), app.client.end()]);
});

describe('the schema', () => {
  it('forces row level security on every table, not merely enables it', async () => {
    const rows = await owner.db.execute<{ relname: string }>(sql`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relforcerowsecurity = false
        and c.relname <> '__drizzle_migrations'
    `);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('runs migrations as a role that FORCE can actually bind', async () => {
    const rows = await owner.db.execute<{ super: boolean; bypass: boolean }>(sql`
      select rolsuper as super, rolbypassrls as bypass
      from pg_roles where rolname = current_user
    `);
    expect(rows[0]?.super).toBe(false);
    expect(rows[0]?.bypass).toBe(false);
  });
});

describe('the role that owns the tables', () => {
  it('reads nothing without opening the maintenance door', async () => {
    // This is the psql-session case. The owner can read every table by
    // privilege and sees none of it.
    const rows = await owner.db.select().from(schema.opportunities);
    expect(rows).toHaveLength(0);
  });

  it('cannot write without it either', async () => {
    const before = await asOwner(owner.db, (tx) => tx.select().from(schema.opportunities));
    await owner.db
      .insert(schema.opportunities)
      .values({
        tenantId: fx.tenantA,
        externalId: 'OWNER-SNEAK',
        createdAt: new Date(),
        currentStage: 'lead',
      })
      .catch(() => undefined);
    const after = await asOwner(owner.db, (tx) => tx.select().from(schema.opportunities));
    expect(after).toHaveLength(before.length);
  });

  it('reads everything once the door is explicitly open', async () => {
    // Scoped to this suite's own fixtures: other suites share the database, and
    // a maintenance read deliberately crosses tenants, so an unscoped assertion
    // would be asserting that nothing else is running.
    const rows = await withMaintenance(owner.db, (tx) =>
      tx
        .select()
        .from(schema.opportunities)
        .where(inArray(schema.opportunities.tenantId, [fx.tenantA, fx.tenantB])),
    );
    expect(rows.map((r) => r.externalId).sort()).toEqual(['A-OPP-1', 'B-OPP-1']);
  });

  it('closes the door again at the end of the transaction', async () => {
    await withMaintenance(owner.db, (tx) => tx.select().from(schema.opportunities));
    const after = await owner.db.select().from(schema.opportunities);
    // Zero regardless of what else is in the database: with the door shut the
    // owner sees nothing at all, not merely nothing of its own.
    expect(after).toHaveLength(0);
  });
});

describe('the maintenance login role', () => {
  it('sees nothing on connecting', async () => {
    const rows = await maint.db.select().from(schema.opportunities);
    expect(rows).toHaveLength(0);
  });

  it('sees everything inside a transaction that says so', async () => {
    const rows = await withMaintenance(maint.db, (tx) =>
      tx
        .select()
        .from(schema.opportunities)
        .where(inArray(schema.opportunities.tenantId, [fx.tenantA, fx.tenantB])),
    );
    expect(rows).toHaveLength(2);
  });
});

describe('the application role', () => {
  it('gains nothing by setting the maintenance flag itself', async () => {
    // zeeraa_app can set the parameter — anyone can set a custom GUC. It is not
    // a member of zeeraa_maintenance, so the policy the flag unlocks does not
    // apply to it, and the flag buys exactly nothing.
    const rows = await app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.maintenance', 'on', true)`);
      return tx.select().from(schema.opportunities);
    });
    expect(rows).toHaveLength(0);
  });

  it('gains nothing by setting it alongside a valid tenant context', async () => {
    const rows = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      async (tx) => {
        await tx.execute(sql`select set_config('app.maintenance', 'on', true)`);
        return tx.select().from(schema.opportunities);
      },
      app.db,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe('A-OPP-1');
  });

  it('is not a member of the maintenance role', async () => {
    const rows = await app.db.execute<{ member: boolean }>(sql`
      select pg_has_role(current_user, 'zeeraa_maintenance', 'usage') as member
    `);
    expect(rows[0]?.member).toBe(false);
  });
});

/**
 * How the SECURITY DEFINER helpers read authorisation, and what they may not do.
 *
 * They used to carry `SET app.maintenance = 'on'` so they could read
 * `memberships` while FORCE bound their owner. That mechanism is gone — a
 * managed Postgres will not grant SET on a custom parameter, see
 * `0002_force_rls.sql` — and they now read `app.membership_index`, which needs
 * no elevation because no application role holds a privilege on it.
 *
 * So the invariant is stronger than it was: these functions must not elevate at
 * all. Not as a SET clause, and above all not with `set_config()` in the body,
 * which would leave the flag set for the remainder of the transaction and hand
 * a caller one elevated statement for free simply by touching a policy.
 */
describe('the definer helpers', () => {
  it('never elevate — no maintenance flag, and no set_config in the body', async () => {
    const rows = await owner.db.execute<{
      proname: string;
      hasflag: boolean;
      bodysets: boolean;
      pinssearchpath: boolean;
    }>(sql`
      select p.proname,
             coalesce(p.proconfig, '{}')::text[] @> array['app.maintenance=on'] as hasflag,
             p.prosrc ilike '%set_config%' as bodysets,
             exists (
               select 1 from unnest(coalesce(p.proconfig, '{}')) c
               where c like 'search_path=%'
             ) as pinssearchpath
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.prosecdef
    `);

    expect(rows.length).toBeGreaterThan(0);
    for (const fn of rows) {
      // The elevation is gone, not merely scoped.
      expect({ name: fn.proname, hasflag: fn.hasflag }).toEqual({
        name: fn.proname,
        hasflag: false,
      });
      expect({ name: fn.proname, bodysets: fn.bodysets }).toEqual({
        name: fn.proname,
        bodysets: false,
      });
      // A SECURITY DEFINER function without a pinned search_path is a
      // privilege-escalation primitive regardless of anything else.
      expect({ name: fn.proname, pinssearchpath: fn.pinssearchpath }).toEqual({
        name: fn.proname,
        pinssearchpath: true,
      });
    }
  });

  /**
   * The new mechanism's own failure modes, which the old one did not have.
   *
   * The helpers answer from a mirror, so two things have to hold that were
   * previously true by construction: the mirror must be unreachable by the
   * application, and it must agree with `memberships`. Both are tested here
   * because "authorisation reads a denormalised copy" is only safe while both
   * do.
   */
  it('answer from a mirror no application role can reach', async () => {
    const rows = await owner.db.execute<{ role: string; readable: boolean; writable: boolean }>(sql`
      select r.rolname as role,
             has_table_privilege(r.rolname, 'app.membership_index', 'select') as readable,
             has_table_privilege(r.rolname, 'app.membership_index', 'insert') as writable
      from pg_roles r
      where r.rolname in ('zeeraa_app', 'zeeraa_auth', 'zeeraa_jobs_runner')
      order by r.rolname
    `);

    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect({ role: row.role, readable: row.readable, writable: row.writable }).toEqual({
        role: row.role,
        readable: false,
        writable: false,
      });
    }
  });

  it('answer from a mirror that agrees with memberships', async () => {
    // Through the gate: FORCE binds the owner on `public.memberships`, so
    // comparing the two sides needs the same door a backfill uses.
    const [row] = await withMaintenance(owner.db, (tx) =>
      tx.execute<{ drift: number }>(sql`
      select (
        select count(*) from (
          select tenant_id, user_id, role from public.memberships
          except
          select tenant_id, user_id, role from app.membership_index
        ) missing
      ) + (
        select count(*) from (
          select tenant_id, user_id, role from app.membership_index
          except
          select tenant_id, user_id, role from public.memberships
        ) extra
      ) as drift
    `),
    );
    expect(Number(row?.drift)).toBe(0);
  });

  it('leaves the flag off the moment each one returns', async () => {
    const readings = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      async (tx) => {
        const out: Record<string, string> = {};
        for (const call of ['app.has_tenant_access()', 'app.effective_role()']) {
          await tx.execute(sql.raw(`select ${call}`));
          const rows = await tx.execute<{ v: string }>(
            sql`select coalesce(current_setting('app.maintenance', true), '') as v`,
          );
          out[call] = rows[0]?.v ?? '';
        }
        return out;
      },
      app.db,
    );
    expect(readings).toEqual({
      'app.has_tenant_access()': '',
      'app.effective_role()': '',
    });
  });

  it('does not let the owner ride the flag past the call', async () => {
    // The scenario a body-level set_config would open: touch a helper, then run
    // an ordinary query in the same transaction and find the door still open.
    const rows = await owner.db.transaction(async (tx) => {
      await tx.execute(sql`select app.is_member_of(${fx.tenantA}::uuid)`);
      const flag = await tx.execute<{ v: string }>(
        sql`select coalesce(current_setting('app.maintenance', true), '') as v`,
      );
      expect(flag[0]?.v).toBe('');
      return tx.select().from(schema.opportunities);
    });
    expect(rows).toHaveLength(0);
  });

  it('leaves the flag off after the cardinality trigger has fired', async () => {
    const flag = await withTenant(
      { tenantId: fx.tenantA, userId: fx.zeeraaAdmin, role: 'zeeraa_admin' },
      async (tx) => {
        await tx
          .insert(schema.memberships)
          .values({ userId: fx.zeeraaAdmin, tenantId: fx.tenantA, role: 'zeeraa_admin' })
          .onConflictDoNothing();
        const rows = await tx.execute<{ v: string }>(
          sql`select coalesce(current_setting('app.maintenance', true), '') as v`,
        );
        return rows[0]?.v;
      },
      app.db,
    );
    expect(flag).toBe('');
  });
});
