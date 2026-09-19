/**
 * Who may move an asset through review, and what that does to a delivered
 * figure.
 *
 * The delivery screen is a compliance record. That only means something if the
 * figure behind it is one Zeeraa cannot raise on its own behalf, so the
 * approval right is a database control (migration 0013) and not a hidden
 * button — these tests are what holds it there.
 *
 * Scoped to the fixture's own tenants throughout: packages test concurrently
 * against one Postgres, so an assertion about "every asset" would be an
 * assertion about another suite's rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../src/schema';
import { withTenant } from '../src/tenant-context';
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

/** A fresh submitted asset in the given tenant, written owner-side. */
async function submittedAsset(tenantId: string, title: string): Promise<string> {
  const [row] = await asOwner(owner.db, (tx) =>
    tx
      .insert(schema.assets)
      .values({
        tenantId,
        type: 'article',
        title,
        commitmentKey: 'articles',
        periodStart: '2026-09-01',
        status: 'submitted',
        submittedAt: new Date(),
      })
      .returning({ id: schema.assets.id }),
  );
  if (!row) throw new Error('asset insert failed');
  return row.id;
}

beforeAll(async () => {
  fx = await seedTwoTenants(owner.db);
});

afterAll(async () => {
  await cleanup(owner.db, fx);
  await Promise.all([owner.client.end(), app.client.end()]);
});

describe('assets are tenant-scoped like everything else', () => {
  it('does not show one client the work Zeeraa did for another', async () => {
    const assetA = await submittedAsset(fx.tenantA, 'A unreleased campaign');

    const seen = await withTenant(
      { tenantId: fx.tenantB, userId: fx.clientViewerB, role: 'client_viewer' },
      (tx) => tx.select().from(schema.assets).where(eq(schema.assets.id, assetA)),
      app.db,
    );
    expect(seen).toHaveLength(0);
  });

  it('refuses an asset written into a tenant the context does not name', async () => {
    const error = await failure(() =>
      withTenant(
        { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
        (tx) =>
          tx.insert(schema.assets).values({
            tenantId: fx.tenantB,
            type: 'article',
            title: 'Smuggled',
            status: 'draft',
          }),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');
  });
});

describe('only the client approves', () => {
  it('lets a client admin approve work in their own tenant', async () => {
    const assetId = await submittedAsset(fx.tenantA, 'September article');

    await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) =>
        tx
          .update(schema.assets)
          .set({
            status: 'approved',
            approvedByUserId: fx.clientAdminA,
            approvedAt: new Date(),
          })
          .where(and(eq(schema.assets.tenantId, fx.tenantA), eq(schema.assets.id, assetId))),
      app.db,
    );

    const [row] = await asOwner(owner.db, (tx) =>
      tx
        .select({ status: schema.assets.status, approvedBy: schema.assets.approvedByUserId })
        .from(schema.assets)
        .where(eq(schema.assets.id, assetId)),
    );
    expect(row?.status).toBe('approved');
    expect(row?.approvedBy).toBe(fx.clientAdminA);
  });

  it('refuses a Zeeraa admin, who may do everything else in this product', async () => {
    const assetId = await submittedAsset(fx.tenantA, 'Zeeraa tries to sign its own work off');

    const error = await failure(() =>
      withTenant(
        { tenantId: fx.tenantA, userId: fx.zeeraaAdmin, role: 'zeeraa_admin' },
        (tx) =>
          tx
            .update(schema.assets)
            .set({ status: 'approved', approvedAt: new Date() })
            .where(eq(schema.assets.id, assetId)),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');
    expect(error.message).toMatch(/client admin/i);
  });

  it('refuses a client viewer', async () => {
    const assetId = await submittedAsset(fx.tenantB, 'B article');

    const error = await failure(() =>
      withTenant(
        { tenantId: fx.tenantB, userId: fx.clientViewerB, role: 'client_viewer' },
        (tx) =>
          tx
            .update(schema.assets)
            .set({ status: 'approved', approvedAt: new Date() })
            .where(eq(schema.assets.id, assetId)),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');
  });

  it('refuses a role claimed in the request but not held in the membership', async () => {
    const assetId = await submittedAsset(fx.tenantA, 'Claiming to be the client');

    // The request says client_admin; `app.effective_role()` reads the
    // membership, which says zeeraa_admin. The membership wins.
    const error = await failure(() =>
      withTenant(
        { tenantId: fx.tenantA, userId: fx.zeeraaAdmin, role: 'client_admin' },
        (tx) =>
          tx
            .update(schema.assets)
            .set({ status: 'approved', approvedAt: new Date() })
            .where(eq(schema.assets.id, assetId)),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');
  });

  it('refuses a rejection from anyone but the client either', async () => {
    const assetId = await submittedAsset(fx.tenantA, 'Sent back by the wrong person');

    const error = await failure(() =>
      withTenant(
        { tenantId: fx.tenantA, userId: fx.zeeraaAdmin, role: 'zeeraa_admin' },
        (tx) =>
          tx
            .update(schema.assets)
            .set({ status: 'changes_requested', changesRequestedReason: 'nope' })
            .where(eq(schema.assets.id, assetId)),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');
  });
});

describe('only Zeeraa submits and publishes', () => {
  it('refuses a client admin submitting work on Zeeraa’s behalf', async () => {
    const [draft] = await asOwner(owner.db, (tx) =>
      tx
        .insert(schema.assets)
        .values({ tenantId: fx.tenantA, type: 'article', title: 'A draft', status: 'draft' })
        .returning({ id: schema.assets.id }),
    );

    const error = await failure(() =>
      withTenant(
        { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
        (tx) =>
          tx
            .update(schema.assets)
            .set({ status: 'submitted', submittedAt: new Date() })
            .where(eq(schema.assets.id, draft!.id)),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');
  });
});

describe('the audit trail names whoever actually decided', () => {
  it('refuses an approval credited to somebody else', async () => {
    const assetId = await submittedAsset(fx.tenantA, 'Credited to the wrong person');

    const error = await failure(() =>
      withTenant(
        { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
        (tx) =>
          tx
            .update(schema.assets)
            .set({
              status: 'approved',
              // Somebody else entirely.
              approvedByUserId: fx.zeeraaAdmin,
              approvedAt: new Date(),
            })
            .where(eq(schema.assets.id, assetId)),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');
    expect(error.message).toMatch(/user who made it/i);
  });
});

describe('the version chain cannot fork', () => {
  it('refuses a second asset superseding the same predecessor', async () => {
    const first = await submittedAsset(fx.tenantA, 'v1');

    await asOwner(owner.db, (tx) =>
      tx.insert(schema.assets).values({
        tenantId: fx.tenantA,
        type: 'article',
        title: 'v2',
        status: 'draft',
        version: 2,
        supersedesAssetId: first,
      }),
    );

    // Two approved rows both replacing v1 would count one article twice.
    const error = await failure(() =>
      asOwner(owner.db, (tx) =>
        tx.insert(schema.assets).values({
          tenantId: fx.tenantA,
          type: 'article',
          title: 'v2, again',
          status: 'draft',
          version: 2,
          supersedesAssetId: first,
        }),
      ),
    );
    expect(error.code).toBe('23505');
  });

  it('refuses an asset that supersedes itself', async () => {
    const assetId = await submittedAsset(fx.tenantA, 'Ouroboros');
    const error = await failure(() =>
      asOwner(owner.db, (tx) =>
        tx
          .update(schema.assets)
          .set({ supersedesAssetId: assetId })
          .where(eq(schema.assets.id, assetId)),
      ),
    );
    expect(error.code).toBe('23514');
  });
});

describe('delivery records are upserted, never appended', () => {
  it('refuses a second record for the same commitment, period and source', async () => {
    await asOwner(owner.db, (tx) =>
      tx.insert(schema.deliverableRecords).values({
        tenantId: fx.tenantA,
        commitmentKey: 'articles',
        periodStart: '2026-09-01',
        deliveredQuantity: '3',
        source: 'derived_from_assets',
      }),
    );

    const error = await failure(() =>
      asOwner(owner.db, (tx) =>
        tx.insert(schema.deliverableRecords).values({
          tenantId: fx.tenantA,
          commitmentKey: 'articles',
          periodStart: '2026-09-01',
          deliveredQuantity: '4',
          source: 'derived_from_assets',
        }),
      ),
    );
    expect(error.code).toBe('23505');
  });

  it('keeps the hand-recorded row and the derived row apart', async () => {
    await asOwner(owner.db, (tx) =>
      tx.insert(schema.deliverableRecords).values({
        tenantId: fx.tenantA,
        commitmentKey: 'articles',
        periodStart: '2026-09-01',
        deliveredQuantity: '9',
        source: 'manual',
      }),
    );

    const rows = await asOwner(owner.db, (tx) =>
      tx
        .select({ source: schema.deliverableRecords.source })
        .from(schema.deliverableRecords)
        .where(
          and(
            eq(schema.deliverableRecords.tenantId, fx.tenantA),
            eq(schema.deliverableRecords.commitmentKey, 'articles'),
          ),
        ),
    );
    expect(rows.map((r) => r.source).sort()).toEqual(['derived_from_assets', 'manual']);
  });
});
