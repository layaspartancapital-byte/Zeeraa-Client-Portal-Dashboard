/**
 * The frozen baseline and the reconciliation checks (migration 0032).
 *
 * A frozen baseline month must not move after it is audited — by a member, by
 * a Zeeraa admin, by the ingestion role, by the owner or by maintenance. Only
 * deleting the whole tenant takes its rows with it. The checks are tenant data,
 * read-only to the application and written by the ingestion role.
 *
 * Scoped to the fixture's own tenants throughout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../src/schema';
import { withJobTenant, withMaintenance, withTenant } from '../src/tenant-context';
import {
  adminClient,
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
const admin = adminClient();
const app = appClient();
const maint = maintClient();
let fx: Fixture;

const snapshot = (tenantId: string, month = '2026-08-01', version = 1) => ({
  tenantId,
  month,
  platform: 'google_ads',
  metric: 'costPerFundedDeal',
  version,
  value: '8582.6081',
  channelSpend: '25747.8243',
  attributed: '3',
  unattributed: '4',
  attributedElsewhere: '0',
  rangeLow: '3678.2606',
  rangeHigh: '8582.6081',
  frozenBy: 'test',
  reason: 'audited',
});

beforeAll(async () => {
  fx = await seedTwoTenants(owner.db);
  await withJobTenant(fx.tenantA, (tx) => tx.insert(schema.baselineSnapshots).values(snapshot(fx.tenantA)));
  await withJobTenant(fx.tenantB, (tx) => tx.insert(schema.baselineSnapshots).values(snapshot(fx.tenantB)));
});

afterAll(async () => {
  await cleanup(owner.db, fx);
  await Promise.all([owner.client.end(), admin.client.end(), app.client.end(), maint.client.end()]);
});

const zeeraaAdminA = () => ({ tenantId: fx.tenantA, userId: fx.zeeraaAdmin, role: 'zeeraa_admin' as const });
const clientAdminA = () => ({ tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' as const });

describe('baseline_snapshots', () => {
  it('shows a client its own frozen months and none of anybody else’s', async () => {
    const rows = await withTenant(clientAdminA(), (tx) => tx.select().from(schema.baselineSnapshots), app.db);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === fx.tenantA)).toBe(true);
  });

  it('refuses an edit to a frozen month from the ingestion role', async () => {
    const denied = await failure(() =>
      withJobTenant(fx.tenantA, (tx) =>
        tx.update(schema.baselineSnapshots).set({ value: '1' }).where(eq(schema.baselineSnapshots.tenantId, fx.tenantA)),
      ),
    );
    expect(denied.code).toBe('42501');
  });

  it('refuses an edit even from a role that bypasses row level security', async () => {
    // Production migrates as a BYPASSRLS role; row level security cannot hold
    // it, so the trigger does.
    const denied = await failure(() =>
      admin.db.update(schema.baselineSnapshots).set({ value: '1' }).where(eq(schema.baselineSnapshots.tenantId, fx.tenantA)),
    );
    expect(denied.message).toMatch(/frozen baseline is not edited/);
  });

  it('refuses a delete from that role while the tenant exists', async () => {
    const denied = await failure(() =>
      admin.db.delete(schema.baselineSnapshots).where(eq(schema.baselineSnapshots.tenantId, fx.tenantA)),
    );
    expect(denied.message).toMatch(/frozen baseline is not edited/);
  });

  it('refuses a member an insert, and lets a Zeeraa admin add the next version', async () => {
    const denied = await failure(() =>
      withTenant(clientAdminA(), (tx) => tx.insert(schema.baselineSnapshots).values(snapshot(fx.tenantA, '2026-08-01', 2)), app.db),
    );
    expect(denied.code).toBe('42501');
    await withTenant(zeeraaAdminA(), (tx) => tx.insert(schema.baselineSnapshots).values(snapshot(fx.tenantA, '2026-08-01', 2)), app.db);
    const rows = await withTenant(zeeraaAdminA(), (tx) => tx.select().from(schema.baselineSnapshots), app.db);
    expect(rows.map((r) => r.version).sort()).toEqual([1, 2]);
  });

  it('refuses the ingestion role a row in a tenant it does not name', async () => {
    const denied = await failure(() =>
      withJobTenant(fx.tenantA, (tx) => tx.insert(schema.baselineSnapshots).values(snapshot(fx.tenantB, '2026-07-01'))),
    );
    expect(denied.code).toBe('42501');
  });

  it('goes with its tenant, and only then', async () => {
    const [temp] = await asOwner(owner.db, (tx) =>
      tx.insert(schema.tenants).values({ name: 'Frozen and gone', slug: `fz-${Date.now()}`, timezone: 'America/New_York' }).returning(),
    );
    await withJobTenant(temp!.id, (tx) => tx.insert(schema.baselineSnapshots).values(snapshot(temp!.id)));
    await withMaintenance(maint.db, (tx) => tx.delete(schema.tenants).where(eq(schema.tenants.id, temp!.id)));
    const [left] = await asOwner(owner.db, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(schema.baselineSnapshots).where(eq(schema.baselineSnapshots.tenantId, temp!.id)),
    );
    expect(left!.n).toBe(0);
  });
});

describe('reconciliation_checks', () => {
  it('is written by the ingestion role and read, only in its own tenant, by the application', async () => {
    await withJobTenant(fx.tenantA, (tx) =>
      tx.insert(schema.reconciliationChecks).values({
        tenantId: fx.tenantA,
        source: 'meta',
        metric: 'spend',
        windowStart: '2026-09-01',
        windowEnd: '2026-09-22',
        ours: '5626.33',
        theirs: '6216.50',
        difference: '-590.17',
        status: 'drift',
        detail: 'not read 19–20 Sep',
      }),
    );
    await withJobTenant(fx.tenantB, (tx) =>
      tx.insert(schema.reconciliationChecks).values({
        tenantId: fx.tenantB,
        source: 'meta',
        metric: 'spend',
        windowStart: '2026-09-01',
        windowEnd: '2026-09-22',
        status: 'match',
      }),
    );
    const rows = await withTenant(clientAdminA(), (tx) => tx.select().from(schema.reconciliationChecks), app.db);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === fx.tenantA)).toBe(true);
  });

  it('refuses a member a write — a drift must not be made to read as a match', async () => {
    const denied = await failure(() =>
      withTenant(
        clientAdminA(),
        (tx) =>
          tx
            .update(schema.reconciliationChecks)
            .set({ status: 'match' })
            .where(eq(schema.reconciliationChecks.tenantId, fx.tenantA)),
        app.db,
      ),
    );
    expect(denied.code).toBe('42501');
  });

  it('refuses a status outside the four', async () => {
    const denied = await failure(() =>
      withJobTenant(fx.tenantA, (tx) =>
        tx.insert(schema.reconciliationChecks).values({
          tenantId: fx.tenantA,
          source: 'meta',
          metric: 'clicks',
          windowStart: '2026-09-01',
          windowEnd: '2026-09-22',
          status: 'fine' as never,
        }),
      ),
    );
    expect(denied.code).toBe('23514');
  });
});

describe('engagement_targets for the ingestion role', () => {
  it('reads its own tenant’s targets and no other’s', async () => {
    await asOwner(owner.db, (tx) =>
      tx.insert(schema.engagementTargets).values([
        { tenantId: fx.tenantA, platform: 'google_ads', monthIndex: 1, costPerFundedDeal: '4000' },
        { tenantId: fx.tenantB, platform: 'google_ads', monthIndex: 1, costPerFundedDeal: '9999' },
      ]),
    );
    const rows = await withJobTenant(fx.tenantA, (tx) => tx.select().from(schema.engagementTargets));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === fx.tenantA)).toBe(true);
  });
});
