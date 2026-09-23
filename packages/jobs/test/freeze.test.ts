/**
 * Freezing the baseline, and the rule for freezing it on its own.
 *
 * A fixture tenant with August 2026 laid out as the audit reconciled it for
 * Google Ads: $25,747.82 of spend, 3 funded deals attributed to Google Ads and
 * 4 to nobody. The frozen figures must be the ramp's — same arithmetic, same
 * coverage, same range — and a second freeze must not overwrite the first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { autoFreeze, freezeBaselineMonths } from '../src/freeze';
import { recordSyncedDays } from '../src/sync-runs';
import { reconciliationWindows } from '../src/reconcile';

const SLUG = `fr-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const NOW = new Date('2026-09-23T16:00:00Z');
let tenantId: string;

beforeAll(async () => {
  tenantId = await withMaintenance(getMaintenanceDb(), async (tx) => {
    const [t] = await tx
      .insert(schema.tenants)
      .values({ name: 'Freeze fixture', slug: SLUG, timezone: 'America/New_York' })
      .returning();
    const id = t!.id;
    await tx.insert(schema.funnelStages).values([
      { tenantId: id, position: 1, key: 'uw_approved', label: 'UW approved' },
      { tenantId: id, position: 2, key: 'funded', label: 'Funded', countsValue: true },
    ]);
    await tx.insert(schema.engagementTargets).values({ tenantId: id, platform: 'google_ads', monthIndex: 1, costPerFundedDeal: '4000' });
    await tx.insert(schema.tenantConfig).values({ tenantId: id, key: 'min_rate_denominator', value: { minimum: 10, render: 3 } });
    await tx.insert(schema.dailyMetrics).values({ tenantId: id, platform: 'google_ads', date: '2026-08-10', spend: '25747.82' });
    const opp = (n: number) => `006F${n}`;
    await tx.insert(schema.opportunities).values(
      [1, 2, 3, 4, 5, 6, 7].map((n) => ({
        tenantId: id,
        externalId: opp(n),
        createdAt: new Date('2026-08-01T15:00:00Z'),
        currentStage: 'Funded',
        fundedAmount: '8200',
      })),
    );
    await tx.insert(schema.stageEvents).values(
      [1, 2, 3, 4, 5, 6, 7].map((n) => ({
        tenantId: id,
        opportunityExternalId: opp(n),
        stage: 'funded',
        occurredAt: new Date('2026-08-12T15:00:00Z'),
        occurredOn: '2026-08-12',
      })),
    );
    await tx.insert(schema.attribution).values(
      [1, 2, 3].map((n) => ({ tenantId: id, opportunityExternalId: opp(n), model: 'last_touch' as const, platform: 'google_ads' })),
    );
    await tx.insert(schema.syncRuns).values({
      tenantId: id,
      platform: 'salesforce',
      trigger: 'test',
      startedAt: new Date('2026-09-23T12:00:00Z'),
      finishedAt: new Date('2026-09-23T12:05:00Z'),
      status: 'succeeded',
    });
    return id;
  });
  await withJobTenant(tenantId, (tx) =>
    recordSyncedDays(tx, tenantId, 'google_ads', { start: '2026-06-01', end: '2026-09-23' }, { today: '2026-09-23', syncRunId: null }),
  );
});

afterAll(async () => {
  await withMaintenance(getMaintenanceDb(), (tx) => tx.delete(schema.tenants).where(eq(schema.tenants.id, tenantId)));
});

const snapshots = () =>
  withMaintenance(getMaintenanceDb(), (tx) =>
    tx.select().from(schema.baselineSnapshots).where(eq(schema.baselineSnapshots.tenantId, tenantId)),
  );

describe('freezeBaselineMonths', () => {
  it('writes nothing on a dry run', async () => {
    const [outcome] = await freezeBaselineMonths({ tenantId, months: ['2026-08'], by: 'test', reason: 'audit', now: NOW, dryRun: true });
    expect(outcome!.detail).toMatch(/^\(dry run\)/);
    expect(await snapshots()).toHaveLength(0);
  });

  it('freezes the six figures the ramp shows, with coverage and range', async () => {
    const [outcome] = await freezeBaselineMonths({ tenantId, months: ['2026-08'], by: 'test', reason: 'audited 23 Sep', now: NOW });
    expect(outcome!.status).toBe('frozen');
    const rows = await snapshots();
    expect(rows).toHaveLength(6);
    const cpf = rows.find((r) => r.metric === 'costPerFundedDeal')!;
    expect(Number(cpf.value)).toBeCloseTo(8_582.61, 2);
    expect(Number(cpf.attributed)).toBe(3);
    expect(Number(cpf.unattributed)).toBe(4);
    expect(Number(cpf.rangeLow)).toBeCloseTo(3_678.26, 2);
    expect(Number(rows.find((r) => r.metric === 'fundedAmount')!.value)).toBe(24_600);
    // No approvals in the fixture: a CPA over zero is withheld with its reason.
    const cpa = rows.find((r) => r.metric === 'cpa')!;
    expect(cpa.value).toBeNull();
    expect(cpa.notMeasuredReason).toBeTruthy();
    expect(cpf.frozenBy).toBe('test');
  });

  it('never overwrites a frozen month', async () => {
    const [outcome] = await freezeBaselineMonths({ tenantId, months: ['2026-08'], by: 'test', reason: 'again', now: NOW });
    expect(outcome!.status).toBe('already_frozen');
    expect(await snapshots()).toHaveLength(6);
  });

  it('refuses the month in progress', async () => {
    const [outcome] = await freezeBaselineMonths({ tenantId, months: ['2026-09'], by: 'test', reason: 'too soon', now: NOW });
    expect(outcome!.status).toBe('deferred');
  });
});

describe('autoFreeze', () => {
  it('waits for the configured days after the month ends', async () => {
    await withMaintenance(getMaintenanceDb(), (tx) =>
      tx.insert(schema.tenantConfig).values({ tenantId, key: 'baseline_freeze', value: { months: ['2026-09'], freezeAfterDays: 5 } }),
    );
    expect(await autoFreeze(tenantId, new Date('2026-10-03T16:00:00Z'))).toEqual([]);
  });

  it('defers a due month while the reconciliation shows drift, and names it', async () => {
    await withJobTenant(tenantId, (tx) =>
      tx.insert(schema.reconciliationChecks).values({
        tenantId,
        source: 'google_ads',
        metric: 'spend',
        windowStart: '2026-09-01',
        windowEnd: '2026-09-30',
        status: 'drift',
        detail: 'not read 19–20 Sep',
      }),
    );
    const [outcome] = await autoFreeze(tenantId, new Date('2026-10-06T16:00:00Z'));
    expect(outcome).toMatchObject({ month: '2026-09', status: 'deferred' });
    expect(outcome!.detail).toMatch(/not read 19–20 Sep/);
  });

  it('freezes it once the reconciliation is clean', async () => {
    await withJobTenant(tenantId, (tx) =>
      tx
        .update(schema.reconciliationChecks)
        .set({ status: 'match', detail: null })
        .where(eq(schema.reconciliationChecks.tenantId, tenantId)),
    );
    const [outcome] = await autoFreeze(tenantId, new Date('2026-10-06T16:00:00Z'));
    expect(outcome).toMatchObject({ month: '2026-09', status: 'frozen' });
    const rows = await snapshots();
    expect(rows.filter((r) => String(r.month).startsWith('2026-09')).every((r) => r.frozenBy === 'daily-job')).toBe(true);
  });
});

describe('reconciliationWindows', () => {
  it('checks last month and this month to yesterday', () => {
    expect(reconciliationWindows('2026-09-23')).toEqual([
      { key: 'last_month', range: { start: '2026-08-01', end: '2026-08-31' } },
      { key: 'month_to_date', range: { start: '2026-09-01', end: '2026-09-22' } },
    ]);
  });

  it('on the first of a month, checks only the month just finished', () => {
    expect(reconciliationWindows('2026-10-01')).toEqual([
      { key: 'last_month', range: { start: '2026-09-01', end: '2026-09-30' } },
    ]);
  });
});
