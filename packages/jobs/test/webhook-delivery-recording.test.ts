/**
 * The recorder, end to end against a real Postgres.
 *
 * The unit tests cover the arithmetic. What they cannot cover is the part that
 * actually failed to exist: whether a delivery lands a row at all, and whether
 * the second one increments the first rather than colliding with the unique
 * index that bounds the table. Both halves are the whole feature.
 *
 * Scoped to a tenant this file creates and deletes: packages test concurrently
 * against one Postgres, and a maintenance read crosses tenants by design.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getMaintenanceDb, schema, withMaintenance } from '@zeeraa/db';
import { recordWebhookDelivery } from '../src/webhook-delivery';

const SLUG = `wh-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const NOW = new Date('2026-09-22T19:47:42Z');
let tenantId: string;

const bucket = () =>
  withMaintenance(getMaintenanceDb(), async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.webhookDeliveries)
      .where(
        and(
          eq(schema.webhookDeliveries.tenantId, tenantId),
          eq(schema.webhookDeliveries.source, 'aloware'),
        ),
      );
    return row ?? null;
  });

beforeAll(async () => {
  tenantId = await withMaintenance(getMaintenanceDb(), async (tx) => {
    const [row] = await tx
      .insert(schema.tenants)
      .values({ name: 'Webhook fixture', slug: SLUG, timezone: 'America/New_York' })
      .returning();
    return row!.id;
  });
});

afterAll(async () => {
  await withMaintenance(getMaintenanceDb(), (tx) =>
    tx.delete(schema.tenants).where(eq(schema.tenants.id, tenantId)),
  );
});

describe('recordWebhookDelivery', () => {
  it('records nothing for a slug that is not a tenant', async () => {
    // What keeps a public endpoint from being a way to grow this table: somebody
    // probing slugs writes no rows at all.
    expect(await recordWebhookDelivery('no-such-tenant-anywhere', 'aloware', {
      kind: 'refused',
      reason: 'unauthenticated',
    })).toBe(false);
  });

  it('lands a bucket for a refusal, which used to leave no trace', async () => {
    const refusal = { kind: 'refused', reason: 'unauthenticated' } as const;
    expect(await recordWebhookDelivery(SLUG, 'aloware', refusal, NOW)).toBe(true);

    const row = await bucket();
    expect(row).not.toBeNull();
    expect(row!.received).toBe(1);
    expect(row!.accepted).toBe(0);
    expect(row!.reasons).toEqual({ unauthenticated: 1 });
    // 19:47Z is 15:47 in New York, the same day. The day is the tenant's.
    expect(row!.day).toBe('2026-09-22');
  });

  it('increments the same bucket rather than colliding with the index', async () => {
    const refusal = { kind: 'refused', reason: 'unauthenticated' } as const;
    await recordWebhookDelivery(SLUG, 'aloware', refusal, NOW);
    const row = await bucket();
    expect(row!.received).toBe(2);
    expect(row!.reasons).toEqual({ unauthenticated: 2 });
  });

  it('counts records read, separately from requests received', async () => {
    await recordWebhookDelivery(
      SLUG,
      'aloware',
      {
        kind: 'read',
        accepted: 3,
        rejected: [{ reason: 'call still in flight (ringing)', count: 2 }],
      },
      NOW,
    );
    const row = await bucket();
    // Three requests, five records: the counts are different grains and the
    // table says so.
    expect(row!.received).toBe(3);
    expect(row!.accepted).toBe(3);
    expect(row!.rejected).toBe(2);
    expect(row!.reasons).toEqual({
      unauthenticated: 2,
      'call still in flight (ringing)': 2,
    });
  });

  it('puts a delivery in the tenant’s own day, not the server’s', async () => {
    // 01:30Z on the 23rd is 21:30 on the 22nd in New York. Getting this wrong
    // splits a night's calls across two buckets and neither reads as a day.
    await recordWebhookDelivery(
      SLUG,
      'aloware',
      { kind: 'refused', reason: 'unauthenticated' },
      new Date('2026-09-23T01:30:00Z'),
    );
    const rows = await withMaintenance(getMaintenanceDb(), (tx) =>
      tx
        .select()
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.tenantId, tenantId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.received).toBe(4);
  });

  it('keeps a second source in its own bucket', async () => {
    await recordWebhookDelivery(SLUG, 'some-other-vendor', { kind: 'refused', reason: 'x' }, NOW);
    const rows = await withMaintenance(getMaintenanceDb(), (tx) =>
      tx
        .select()
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.tenantId, tenantId)),
    );
    expect(rows).toHaveLength(2);
  });
});
