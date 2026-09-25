/**
 * "Sync now" is open to clients, so the throttle and the tenant scope are
 * tested against the database: the ingestion role, row level security and the
 * advisory lock are what hold them, not the button.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { runManualSync } from '../src/manual-sync';
import { openSyncRun } from '../src/sync-runs';
import type { IncrementalOptions, IncrementalResult } from '../src/incremental';

const stamp = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
let a: string;
let b: string;

/** Stands in for the real sync: records who it was asked for and writes the
 * ledger row a real run writes, as the ingestion role. */
function fakeSync(calls: IncrementalOptions[], hold?: Promise<void>) {
  return async (options: IncrementalOptions = {}): Promise<IncrementalResult> => {
    calls.push(options);
    await withJobTenant(options.tenantId!, (tx) =>
      openSyncRun(tx, options.tenantId!, options.trigger!, options.now!, 'meta'),
    );
    await hold;
    return { ok: true, outcomes: [], durationMs: 0 } as unknown as IncrementalResult;
  };
}

const t0 = new Date('2026-09-25T14:00:00Z');
const plus = (ms: number) => new Date(t0.getTime() + ms);

beforeAll(async () => {
  [a, b] = await withMaintenance(getMaintenanceDb(), async (tx) => {
    const rows = await tx
      .insert(schema.tenants)
      .values([
        { name: 'Manual sync A', slug: `ms-a-${stamp}`, timezone: 'America/New_York' },
        { name: 'Manual sync B', slug: `ms-b-${stamp}`, timezone: 'America/New_York' },
      ])
      .returning({ id: schema.tenants.id });
    return [rows[0]!.id, rows[1]!.id] as const;
  });
});

afterAll(async () => {
  await withMaintenance(getMaintenanceDb(), (tx) =>
    tx.delete(schema.tenants).where(inArray(schema.tenants.id, [a, b])),
  );
});

describe('runManualSync', () => {
  it('runs the first sync for the named tenant only', async () => {
    const calls: IncrementalOptions[] = [];
    const out = await runManualSync({ tenantId: a, now: t0, run: fakeSync(calls) });
    expect(out.status).toBe('ran');
    expect(calls).toEqual([{ tenantId: a, platforms: undefined, trigger: 'manual', now: t0 }]);
  });

  it('refuses a second within five minutes, whatever the platform, and says why', async () => {
    const calls: IncrementalOptions[] = [];
    const out = await runManualSync({ tenantId: a, platforms: ['salesforce'], now: plus(2 * 60_000 + 10_000), run: fakeSync(calls) });
    expect(out).toMatchObject({ status: 'throttled', message: 'Synced 2 min ago, next available in 3 min' });
    expect(calls).toEqual([]);
  });

  it("does not throttle another tenant: A's sync is not B's", async () => {
    const calls: IncrementalOptions[] = [];
    const out = await runManualSync({ tenantId: b, now: plus(60_000), run: fakeSync(calls) });
    expect(out.status).toBe('ran');
    expect(calls.map((c) => c.tenantId)).toEqual([b]);
  });

  it('runs again once five minutes have passed', async () => {
    const calls: IncrementalOptions[] = [];
    const out = await runManualSync({ tenantId: a, now: plus(5 * 60_000), run: fakeSync(calls) });
    expect(out.status).toBe('ran');
  });

  it('lets only one of two simultaneous clicks through', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const calls: IncrementalOptions[] = [];
    const now = plus(20 * 60_000);
    const first = runManualSync({ tenantId: a, now, run: fakeSync(calls, hold) });
    // Let the first take the lock before the second asks.
    while (calls.length === 0) await new Promise((r) => setTimeout(r, 10));
    const second = await runManualSync({ tenantId: a, now, run: fakeSync(calls) });
    release();
    expect((await first).status).toBe('ran');
    expect(second.status).toBe('running');
    expect(calls).toHaveLength(1);
  });

  it('ignores scheduled runs: only a manual sync starts the clock', async () => {
    await withJobTenant(b, (tx) => openSyncRun(tx, b, 'cron-hourly', plus(59 * 60_000), 'meta'));
    const out = await runManualSync({ tenantId: b, now: plus(60 * 60_000), run: fakeSync([]) });
    expect(out.status).toBe('ran');
  });

  it('refuses to run without a tenant, which would sync every tenant', async () => {
    const calls: IncrementalOptions[] = [];
    await expect(runManualSync({ tenantId: '', run: fakeSync(calls) })).rejects.toThrow(/names its tenant/);
    expect(calls).toEqual([]);
  });

  it('writes nothing to the other tenant', async () => {
    const rows = await withMaintenance(getMaintenanceDb(), (tx) =>
      tx.select({ tenantId: schema.syncRuns.tenantId, trigger: schema.syncRuns.trigger }).from(schema.syncRuns).where(eq(schema.syncRuns.tenantId, b)),
    );
    expect(rows.filter((r) => r.trigger === 'manual')).toHaveLength(2);
  });
});
