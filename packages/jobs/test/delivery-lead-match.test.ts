/**
 * Matching a pushed call to its lead on arrival.
 *
 * Speed to lead is measured on matched calls, so a call that waits an hour for
 * the Salesforce sweep is a call the figure cannot see for an hour — which
 * defeats pushing it. What this file is really guarding is that the fast path
 * and the sweep agree: a scoped matcher that quietly resolved an ambiguous
 * number would put a figure on screen the hourly pass then took away.
 *
 * Scoped to a tenant this file creates and deletes: packages test concurrently
 * against one Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { resolveCallLeads, resolveLeadsForDelivery, upsertCalls } from '../src/aloware/writer';
import type { CallRow } from '@zeeraa/connectors';

const SLUG = `match-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
let tenantId: string;
const LEAD_AT = new Date('2026-09-20T09:38:15Z');

const call = (externalId: string, contactKey: string | null): CallRow => ({
  externalId,
  occurredAt: new Date('2026-09-22T20:36:51Z'),
  direction: 'inbound',
  outcome: 'connected',
  disposition: 'completed',
  talkTimeSeconds: 164,
  durationSeconds: 179,
  contactNumber: contactKey,
  contactKey,
  contactExternalId: null,
  agentName: null,
  answeredBriefly: false,
});

const leadOf = (externalId: string) =>
  withMaintenance(getMaintenanceDb(), (tx) =>
    tx
      .select({ lead: schema.calls.leadExternalId })
      .from(schema.calls)
      .where(and(eq(schema.calls.tenantId, tenantId), eq(schema.calls.externalId, externalId))),
  ).then((rows) => rows[0]?.lead ?? null);

beforeAll(async () => {
  tenantId = await withMaintenance(getMaintenanceDb(), async (tx) => {
    const [row] = await tx
      .insert(schema.tenants)
      .values({ name: 'Match fixture', slug: SLUG, timezone: 'America/New_York' })
      .returning();
    const id = row!.id;
    await tx.insert(schema.leads).values([
      // One lead, one number: matchable.
      { tenantId: id, externalId: 'LEAD-SOLE', phoneKey: '5034625891', createdAt: LEAD_AT },
      // Two leads sharing a switchboard: matchable by nobody.
      { tenantId: id, externalId: 'LEAD-SHARED-A', phoneKey: '2125550000', createdAt: LEAD_AT },
      { tenantId: id, externalId: 'LEAD-SHARED-B', phoneKey: '2125550000', createdAt: LEAD_AT },
    ]);
    return id;
  });
});

afterAll(async () => {
  await withMaintenance(getMaintenanceDb(), (tx) =>
    tx.delete(schema.tenants).where(eq(schema.tenants.id, tenantId)),
  );
});

describe('resolveLeadsForDelivery', () => {
  it('matches a delivered call to its lead straight away', async () => {
    await withJobTenant(tenantId, (tx) =>
      upsertCalls(tx, tenantId, [call('C-1', '5034625891')], 'webhook', null),
    );
    const result = await withJobTenant(tenantId, (tx) =>
      resolveLeadsForDelivery(tx, tenantId, ['5034625891']),
    );
    expect(result.matched).toBe(1);
    expect(await leadOf('C-1')).toBe('LEAD-SOLE');
  });

  it('leaves an ambiguous number unmatched, exactly as the sweep does', async () => {
    // The rule that matters most: picking one of two leads would produce a
    // speed-to-lead figure that looks measured and is arbitrary.
    await withJobTenant(tenantId, (tx) =>
      upsertCalls(tx, tenantId, [call('C-2', '2125550000')], 'webhook', null),
    );
    const result = await withJobTenant(tenantId, (tx) =>
      resolveLeadsForDelivery(tx, tenantId, ['2125550000']),
    );
    expect(result.matched).toBe(0);
    expect(result.ambiguous).toBe(1);
    expect(await leadOf('C-2')).toBeNull();

    // And the sweep agrees, which is the property the shared helpers exist for.
    await withJobTenant(tenantId, (tx) => resolveCallLeads(tx, tenantId));
    expect(await leadOf('C-2')).toBeNull();
  });

  it('reports a number no lead holds, rather than failing', async () => {
    await withJobTenant(tenantId, (tx) =>
      upsertCalls(tx, tenantId, [call('C-3', '9995551234')], 'webhook', null),
    );
    const result = await withJobTenant(tenantId, (tx) =>
      resolveLeadsForDelivery(tx, tenantId, ['9995551234']),
    );
    expect(result).toEqual({ matched: 0, unmatched: 1, ambiguous: 0 });
    expect(await leadOf('C-3')).toBeNull();
  });

  it('heals an earlier call on the same number, not only the one delivered', async () => {
    // A call that arrived before its lead was synced is exactly the row that
    // should resolve when the next call from that merchant comes in.
    await withJobTenant(tenantId, (tx) =>
      upsertCalls(tx, tenantId, [call('C-4-older', '4155558888')], 'webhook', null),
    );
    expect(await leadOf('C-4-older')).toBeNull();

    await withMaintenance(getMaintenanceDb(), (tx) =>
      tx
        .insert(schema.leads)
        .values({
          tenantId,
          externalId: 'LEAD-LATE',
          phoneKey: '4155558888',
          createdAt: LEAD_AT,
        }),
    );
    await withJobTenant(tenantId, (tx) =>
      upsertCalls(tx, tenantId, [call('C-4-newer', '4155558888')], 'webhook', null),
    );

    const result = await withJobTenant(tenantId, (tx) =>
      resolveLeadsForDelivery(tx, tenantId, ['4155558888']),
    );
    expect(result.matched).toBe(2);
    expect(await leadOf('C-4-older')).toBe('LEAD-LATE');
    expect(await leadOf('C-4-newer')).toBe('LEAD-LATE');
  });

  it('is idempotent, so a re-delivery changes nothing', async () => {
    const again = await withJobTenant(tenantId, (tx) =>
      resolveLeadsForDelivery(tx, tenantId, ['5034625891']),
    );
    expect(again.matched).toBe(0);
    expect(await leadOf('C-1')).toBe('LEAD-SOLE');
  });

  it('does nothing, cheaply, when a delivery carries no usable number', async () => {
    const result = await withJobTenant(tenantId, (tx) =>
      resolveLeadsForDelivery(tx, tenantId, []),
    );
    expect(result).toEqual({ matched: 0, unmatched: 0, ambiguous: 0 });
  });

  it('touches only the keys it was given, leaving the rest to the sweep', async () => {
    // The scoping is the whole reason this function exists rather than calling
    // the sweep: a delivery must not pay for the tenant's history.
    await withJobTenant(tenantId, (tx) =>
      upsertCalls(tx, tenantId, [call('C-5', '5034625891')], 'webhook', null),
    );
    const other = await withJobTenant(tenantId, (tx) =>
      resolveLeadsForDelivery(tx, tenantId, ['9995551234']),
    );
    expect(other.matched).toBe(0);
    expect(await leadOf('C-5')).toBeNull();
  });
});
