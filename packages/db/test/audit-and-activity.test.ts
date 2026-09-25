/**
 * The account audit log and last-seen activity (migration 0040).
 *
 * `audit_events` is Zeeraa's record: readable by a Zeeraa admin in the current
 * tenant and nobody else, written only as the person it names as the actor,
 * and never changed or removed by any role — the trigger holds even against a
 * connection that bypasses row level security. `user_activity` is written by
 * each person for themselves and read by a Zeeraa admin only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../src/schema';
import { withTenant, withUserOnly } from '../src/tenant-context';
import {
  adminClient,
  appClient,
  asOwner,
  cleanup,
  failure,
  ownerClient,
  seedTwoTenants,
  type Fixture,
} from './fixtures';

const owner = ownerClient();
const admin = adminClient();
const app = appClient();
let fx: Fixture;

type Role = 'zeeraa_admin' | 'client_admin' | 'client_viewer';
const inTenant = (tenantId: string, userId: string, role: Role) =>
  <T,>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant({ tenantId, userId, role }, fn, app.db);

const event = (over: Partial<typeof schema.auditEvents.$inferInsert> = {}) => ({
  tenantId: fx.tenantA,
  action: 'reset_password' as const,
  actorUserId: fx.zeeraaAdminAOnly,
  actorEmail: 'zeeraa@example.test',
  subjectUserId: fx.clientAdminA,
  subjectEmail: 'client@example.test',
  ...over,
});

beforeAll(async () => {
  fx = await seedTwoTenants(owner.db);
  // One entry in tenant B, which nothing in tenant A may read.
  await inTenant(fx.tenantB, fx.zeeraaAdmin, 'zeeraa_admin')((tx) =>
    tx.insert(schema.auditEvents).values(
      event({ tenantId: fx.tenantB, actorUserId: fx.zeeraaAdmin, subjectUserId: fx.clientViewerB }),
    ),
  );
});

afterAll(async () => {
  // Deleting the tenants is the one deletion the log allows; `cleanup` doing it
  // without error is part of what this file proves.
  await cleanup(owner.db, fx);
  await Promise.all([owner.client.end(), admin.client.end(), app.client.end()]);
});

describe('audit_events', () => {
  it('lets a Zeeraa admin record an action as themselves and read it back', async () => {
    const as = inTenant(fx.tenantA, fx.zeeraaAdminAOnly, 'zeeraa_admin');
    await as((tx) => tx.insert(schema.auditEvents).values(event()));
    const rows = await as((tx) => tx.select().from(schema.auditEvents));
    expect(rows.map((r) => [r.tenantId, r.action])).toEqual([[fx.tenantA, 'reset_password']]);
  });

  it('refuses an entry naming somebody else as the actor', async () => {
    const denied = await failure(() =>
      inTenant(fx.tenantA, fx.zeeraaAdminAOnly, 'zeeraa_admin')((tx) =>
        tx.insert(schema.auditEvents).values(event({ actorUserId: fx.zeeraaAdmin })),
      ),
    );
    expect(denied.code).toBe('42501');
  });

  it('refuses a client admin writing or reading it', async () => {
    const as = inTenant(fx.tenantA, fx.clientAdminA, 'client_admin');
    const denied = await failure(() =>
      as((tx) => tx.insert(schema.auditEvents).values(event({ actorUserId: fx.clientAdminA }))),
    );
    expect(denied.code).toBe('42501');
    expect(await as((tx) => tx.select().from(schema.auditEvents))).toEqual([]);
  });

  it('shows a Zeeraa admin only the current tenant', async () => {
    const rows = await inTenant(fx.tenantA, fx.zeeraaAdmin, 'zeeraa_admin')((tx) =>
      tx.select({ tenantId: schema.auditEvents.tenantId }).from(schema.auditEvents),
    );
    expect(new Set(rows.map((r) => r.tenantId))).toEqual(new Set([fx.tenantA]));
  });

  it('records a sign-in as the person, only in a tenant they hold', async () => {
    const signIn = (tenantId: string, userId: string) =>
      withUserOnly(
        userId,
        (tx) =>
          tx.insert(schema.auditEvents).values(
            event({ tenantId, action: 'sign_in', actorUserId: userId, subjectUserId: userId }),
          ),
        app.db,
      );
    await signIn(fx.tenantA, fx.clientAdminA);
    expect((await failure(() => signIn(fx.tenantB, fx.clientAdminA))).code).toBe('42501');

    const forged = await failure(() =>
      withUserOnly(
        fx.clientAdminA,
        (tx) =>
          tx.insert(schema.auditEvents).values(
            event({ action: 'sign_in', actorUserId: fx.zeeraaAdminAOnly, subjectUserId: fx.zeeraaAdminAOnly }),
          ),
        app.db,
      ),
    );
    expect(forged.code).toBe('42501');
  });

  it('grants the application no update or delete', async () => {
    const as = inTenant(fx.tenantA, fx.zeeraaAdminAOnly, 'zeeraa_admin');
    const update = await failure(() =>
      as((tx) => tx.update(schema.auditEvents).set({ subjectEmail: 'x@example.test' })),
    );
    expect(update.message).toMatch(/permission denied/);
    const remove = await failure(() => as((tx) => tx.delete(schema.auditEvents)));
    expect(remove.message).toMatch(/permission denied/);
  });

  it('refuses an edit, a delete and a truncate even to a role that bypasses row level security', async () => {
    const mine = eq(schema.auditEvents.tenantId, fx.tenantA);
    const update = await failure(() =>
      admin.db.update(schema.auditEvents).set({ subjectEmail: 'x@example.test' }).where(mine),
    );
    expect(update.message).toMatch(/audit log is not edited/);
    const remove = await failure(() => admin.db.delete(schema.auditEvents).where(mine));
    expect(remove.message).toMatch(/audit log is not edited/);
    const truncate = await failure(() => admin.db.execute(sql`truncate public.audit_events`));
    expect(truncate.message).toMatch(/not truncated/);
  });
});

describe('user_activity', () => {
  const upsert = (userId: string, role: Role, path: string) =>
    inTenant(fx.tenantA, userId, role)((tx) =>
      tx
        .insert(schema.userActivity)
        .values({ tenantId: fx.tenantA, userId, lastPath: path })
        .onConflictDoUpdate({
          target: [schema.userActivity.tenantId, schema.userActivity.userId],
          set: { lastSeenAt: new Date(), lastPath: path },
        }),
    );

  it('lets anybody record their own, twice', async () => {
    await upsert(fx.clientAdminA, 'client_admin', '/a');
    await upsert(fx.clientAdminA, 'client_admin', '/a/funnel');
    const [row] = await asOwner(owner.db, (tx) =>
      tx.select().from(schema.userActivity).where(eq(schema.userActivity.userId, fx.clientAdminA)),
    );
    expect(row?.lastPath).toBe('/a/funnel');
  });

  it('refuses writing somebody else’s, a Zeeraa admin included', async () => {
    const denied = await failure(() =>
      inTenant(fx.tenantA, fx.zeeraaAdminAOnly, 'zeeraa_admin')((tx) =>
        tx.insert(schema.userActivity).values({ tenantId: fx.tenantA, userId: fx.zeeraaAdmin, lastPath: '/a' }),
      ),
    );
    expect(denied.code).toBe('42501');
  });

  it('shows everybody’s to a Zeeraa admin and only their own to a client', async () => {
    await upsert(fx.zeeraaAdminAOnly, 'zeeraa_admin', '/a/people');
    const mine = inArray(schema.userActivity.userId, [fx.clientAdminA, fx.zeeraaAdminAOnly]);

    const zeeraa = await inTenant(fx.tenantA, fx.zeeraaAdminAOnly, 'zeeraa_admin')((tx) =>
      tx.select().from(schema.userActivity).where(mine),
    );
    expect(zeeraa).toHaveLength(2);

    const client = await inTenant(fx.tenantA, fx.clientAdminA, 'client_admin')((tx) =>
      tx.select().from(schema.userActivity).where(mine),
    );
    expect(client.map((r) => r.userId)).toEqual([fx.clientAdminA]);
  });

  it('grants no delete', async () => {
    const denied = await failure(() =>
      inTenant(fx.tenantA, fx.clientAdminA, 'client_admin')((tx) => tx.delete(schema.userActivity)),
    );
    expect(denied.message).toMatch(/permission denied/);
  });
});
