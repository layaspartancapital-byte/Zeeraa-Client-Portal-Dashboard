/**
 * A merge survivor takes its merged leads' channel when it has none.
 *
 * Salesforce gives the survivor the earliest submission's date and only its
 * own attribution fields, so without this a merge moves a lead from a paid
 * channel to unattributed in a month that may already be frozen — which is
 * what July and August's baselines caught on 6 October 2026.
 *
 * Scoped to a tenant this file creates and deletes: packages test concurrently
 * against one Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { inheritMergedChannels } from '../src/salesforce/writer';

const SLUG = `merge-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
let tenantId: string;

const lead = (
  externalId: string,
  createdOn: string,
  channel: string | null,
  mergedInto: string | null = null,
) => ({
  tenantId,
  externalId,
  createdAt: new Date(`${createdOn}T15:00:00Z`),
  createdOn,
  channel,
  mergedInto,
  excludedReason: mergedInto ? 'merged' : null,
});

const channelOf = (externalId: string) =>
  withMaintenance(getMaintenanceDb(), (tx) =>
    tx
      .select({ channel: schema.leads.channel })
      .from(schema.leads)
      .where(and(eq(schema.leads.tenantId, tenantId), eq(schema.leads.externalId, externalId))),
  ).then((rows) => rows[0]?.channel ?? null);

const run = () => withJobTenant(tenantId, (tx) => inheritMergedChannels(tx, tenantId));

beforeAll(async () => {
  tenantId = await withMaintenance(getMaintenanceDb(), async (tx) => {
    const [row] = await tx
      .insert(schema.tenants)
      .values({ name: 'Merge fixture', slug: SLUG, timezone: 'America/New_York' })
      .returning();
    return row!.id;
  });
  await withMaintenance(getMaintenanceDb(), (tx) =>
    tx.insert(schema.leads).values([
      // The July case: a Meta submission merged into a survivor with no channel.
      lead('SURVIVOR', '2026-07-16', null),
      lead('LOSER-META', '2026-07-16', 'meta', 'SURVIVOR'),
      // Two losers: the earliest one with a channel decides.
      lead('SURVIVOR-2', '2026-08-09', null),
      lead('LOSER-LATER', '2026-08-20', 'meta', 'SURVIVOR-2'),
      lead('LOSER-EARLIER', '2026-08-09', 'google_ads', 'SURVIVOR-2'),
      // The survivor's own evidence wins.
      lead('SURVIVOR-OWN', '2026-08-01', 'google_ads'),
      lead('LOSER-OTHER', '2026-08-01', 'meta', 'SURVIVOR-OWN'),
      // A chain: A into B into C.
      lead('C', '2026-08-02', null),
      lead('B', '2026-08-02', null, 'C'),
      lead('A', '2026-08-02', 'meta', 'B'),
      // Nothing to inherit.
      lead('SURVIVOR-NONE', '2026-08-03', null),
      lead('LOSER-NONE', '2026-08-03', null, 'SURVIVOR-NONE'),
    ]),
  );
});

afterAll(async () => {
  await withMaintenance(getMaintenanceDb(), (tx) =>
    tx.delete(schema.tenants).where(eq(schema.tenants.id, tenantId)),
  );
});

describe('inheritMergedChannels', () => {
  it('gives a survivor with no channel its merged lead’s channel', async () => {
    await run();
    expect(await channelOf('SURVIVOR')).toBe('meta');
  });

  it('takes the earliest merged lead that has a channel', async () => {
    expect(await channelOf('SURVIVOR-2')).toBe('google_ads');
  });

  it('never overrides the survivor’s own channel', async () => {
    expect(await channelOf('SURVIVOR-OWN')).toBe('google_ads');
  });

  it('follows a chain of merges to the last survivor', async () => {
    expect(await channelOf('C')).toBe('meta');
  });

  it('leaves a survivor with nothing to inherit unattributed', async () => {
    expect(await channelOf('SURVIVOR-NONE')).toBeNull();
  });

  it('re-applies after a sync writes the survivor’s empty fields back, and is otherwise a no-op', async () => {
    await withMaintenance(getMaintenanceDb(), (tx) =>
      tx
        .update(schema.leads)
        .set({ channel: null })
        .where(and(eq(schema.leads.tenantId, tenantId), eq(schema.leads.externalId, 'SURVIVOR'))),
    );
    expect(await run()).toBe(1);
    expect(await channelOf('SURVIVOR')).toBe('meta');
    expect(await run()).toBe(0);
  });
});
