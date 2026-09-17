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
import { sql } from 'drizzle-orm';
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
    const rows = await withMaintenance(owner.db, (tx) =>
      tx.select().from(schema.opportunities),
    );
    expect(rows.map((r) => r.externalId).sort()).toEqual(['A-OPP-1', 'B-OPP-1']);
  });

  it('closes the door again at the end of the transaction', async () => {
    await withMaintenance(owner.db, (tx) => tx.select().from(schema.opportunities));
    const after = await owner.db.select().from(schema.opportunities);
    expect(after).toHaveLength(0);
  });
});

describe('the maintenance login role', () => {
  it('sees nothing on connecting', async () => {
    const rows = await maint.db.select().from(schema.opportunities);
    expect(rows).toHaveLength(0);
  });

  it('sees everything inside a transaction that says so', async () => {
    const rows = await withMaintenance(maint.db, (tx) => tx.select().from(schema.opportunities));
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
