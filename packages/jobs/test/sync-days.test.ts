/**
 * The per-day read ledger (migration 0030) and the resume that uses it.
 *
 * The audit of 23 September 2026 found Meta and GA4 missing 19–20 September
 * and 18 September stored from a read taken before the day ended. These pin
 * the three properties that make that self-healing: a day read while open is
 * not final, a final day stays final, and the next window starts at the oldest
 * day that is not final.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { recordSkippedRun, recordSyncedDays, resumeWindow, salesforceRunInFlight } from '../src/sync-runs';

const SLUG = `sd-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
let tenantId: string;

const days = () =>
  withMaintenance(getMaintenanceDb(), (tx) =>
    tx
      .select({ day: schema.syncDays.day, final: schema.syncDays.final })
      .from(schema.syncDays)
      .where(and(eq(schema.syncDays.tenantId, tenantId), eq(schema.syncDays.platform, 'meta')))
      .orderBy(schema.syncDays.day),
  );

beforeAll(async () => {
  tenantId = await withMaintenance(getMaintenanceDb(), async (tx) => {
    const [row] = await tx
      .insert(schema.tenants)
      .values({ name: 'Sync days fixture', slug: SLUG, timezone: 'America/New_York' })
      .returning();
    return row!.id;
  });
});

afterAll(async () => {
  await withMaintenance(getMaintenanceDb(), (tx) =>
    tx.delete(schema.tenants).where(eq(schema.tenants.id, tenantId)),
  );
});

describe('recordSyncedDays', () => {
  it('marks a day read while it is still open as covered, not final', async () => {
    // The read of 18 September at 11:01pm Eastern: the 18th was not over.
    await withJobTenant(tenantId, (tx) =>
      recordSyncedDays(tx, tenantId, 'meta', { start: '2026-09-17', end: '2026-09-18' }, {
        today: '2026-09-18',
        syncRunId: null,
      }),
    );
    expect(await days()).toEqual([
      { day: '2026-09-17', final: true },
      { day: '2026-09-18', final: false },
    ]);
  });

  it('never records a day that has not started', async () => {
    const written = await withJobTenant(tenantId, (tx) =>
      recordSyncedDays(tx, tenantId, 'meta', { start: '2026-09-30', end: '2026-10-02' }, {
        today: '2026-09-29',
        syncRunId: null,
      }),
    );
    expect(written).toBe(0);
  });

  it('keeps a final day final when a later read is not', async () => {
    await withJobTenant(tenantId, (tx) =>
      recordSyncedDays(tx, tenantId, 'meta', { start: '2026-09-17', end: '2026-09-17' }, {
        today: '2026-09-17',
        syncRunId: null,
      }),
    );
    expect((await days())[0]).toEqual({ day: '2026-09-17', final: true });
  });

  it('holds a settling source back a day', async () => {
    await withJobTenant(tenantId, (tx) =>
      recordSyncedDays(tx, tenantId, 'ga4', { start: '2026-09-20', end: '2026-09-21' }, {
        today: '2026-09-22',
        settleDays: 1,
        syncRunId: null,
      }),
    );
    const ga4 = await withMaintenance(getMaintenanceDb(), (tx) =>
      tx
        .select({ day: schema.syncDays.day, final: schema.syncDays.final })
        .from(schema.syncDays)
        .where(and(eq(schema.syncDays.tenantId, tenantId), eq(schema.syncDays.platform, 'ga4')))
        .orderBy(schema.syncDays.day),
    );
    expect(ga4).toEqual([
      { day: '2026-09-20', final: true },
      { day: '2026-09-21', final: false },
    ]);
  });
});

describe('resumeWindow', () => {
  it('starts at the oldest day not read final, not at a fixed two days', async () => {
    // 17th final, 18th open, 19th–21st never read: on the 22nd the window
    // must reach back to the 18th.
    const range = await withJobTenant(tenantId, (tx) =>
      resumeWindow(tx, tenantId, 'meta', { today: '2026-09-22', floorDays: 2, maxDays: 6 }),
    );
    expect(range).toEqual({ start: '2026-09-18', end: '2026-09-22' });
  });

  it('falls back to the floor once every earlier day is final', async () => {
    await withJobTenant(tenantId, (tx) =>
      recordSyncedDays(tx, tenantId, 'meta', { start: '2026-09-16', end: '2026-09-22' }, {
        today: '2026-09-23',
        syncRunId: null,
      }),
    );
    const range = await withJobTenant(tenantId, (tx) =>
      resumeWindow(tx, tenantId, 'meta', { today: '2026-09-23', floorDays: 2, maxDays: 6 }),
    );
    expect(range).toEqual({ start: '2026-09-22', end: '2026-09-23' });
  });

  it('is bounded by the catch-up window', async () => {
    const range = await withJobTenant(tenantId, (tx) =>
      resumeWindow(tx, tenantId, 'search_console', {
        today: '2026-09-23',
        floorDays: 7,
        maxDays: 35,
        lastDay: '2026-09-20',
      }),
    );
    expect(range).toEqual({ start: '2026-08-17', end: '2026-09-20' });
  });
});

describe('recordSkippedRun', () => {
  it('leaves a row for a platform the runner did not reach', async () => {
    await withJobTenant(tenantId, (tx) =>
      recordSkippedRun(tx, tenantId, 'meta', 'cron-hourly', new Date(), 'Not started: 46s spent.'),
    );
    const [row] = await withMaintenance(getMaintenanceDb(), (tx) =>
      tx.select().from(schema.syncRuns).where(eq(schema.syncRuns.tenantId, tenantId)),
    );
    expect(row).toMatchObject({ platform: 'meta', status: 'skipped', error: 'Not started: 46s spent.' });
  });
});

describe('salesforceRunInFlight', () => {
  it('sees a Salesforce run started minutes ago and still open, and not one that died long ago', async () => {
    const now = new Date('2026-09-23T22:10:00Z');
    await withJobTenant(tenantId, (tx) =>
      tx.insert(schema.syncRuns).values([
        { tenantId, platform: 'salesforce', trigger: 'cron-salesforce', startedAt: new Date('2026-09-23T21:00:00Z'), status: 'running' },
      ]),
    );
    // An hour-old row still marked running is a crash, not a run in progress.
    expect(await withJobTenant(tenantId, (tx) => salesforceRunInFlight(tx, tenantId, now))).toBeNull();

    await withJobTenant(tenantId, (tx) =>
      tx.insert(schema.syncRuns).values({ tenantId, platform: 'salesforce', trigger: 'cron-salesforce', startedAt: new Date('2026-09-23T22:05:00Z'), status: 'running' }),
    );
    expect((await withJobTenant(tenantId, (tx) => salesforceRunInFlight(tx, tenantId, now)))?.toISOString()).toBe('2026-09-23T22:05:00.000Z');
  });
});
