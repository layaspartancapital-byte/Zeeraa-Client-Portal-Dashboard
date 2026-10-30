/**
 * Restating a frozen lead count that Salesforce moved (migration 0047).
 *
 * A fixture tenant with August 2026 frozen: four Google Ads leads, two of
 * them qualified, and one Direct & other lead. A merge in Salesforce must be
 * traced to the leads it moved and restated by the daily job, with a reason
 * naming them; a lead the code moves with its Salesforce record unchanged
 * must not be restated by anybody but a person. The recording is
 * append-only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { autoCorrectLeadFigures, freezeChannelFigures } from '../src/freeze';
import { isProvenLeadChange, leadFigureProofs } from '../src/baseline-leads';

const SLUG = `bl-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const NOW = new Date('2026-09-23T16:00:00Z');
/** The daily job, a day later: a recording is keyed on its instant. */
const LATER = new Date('2026-09-24T08:00:00Z');
const MONTH = '2026-08';
let tenantId: string;

const lead = (n: number, extra: Partial<typeof schema.leads.$inferInsert> = {}) => ({
  tenantId,
  externalId: `00QBL${n}`,
  createdAt: new Date(`2026-08-1${n}T15:00:00Z`),
  createdOn: `2026-08-1${n}`,
  ...extra,
});

const asMaint = <T>(fn: (tx: Parameters<Parameters<typeof withMaintenance>[1]>[0]) => Promise<T>) =>
  withMaintenance(getMaintenanceDb(), fn);

const setLead = (n: number, values: Partial<typeof schema.leads.$inferInsert>) =>
  asMaint((tx) =>
    tx
      .update(schema.leads)
      .set(values)
      .where(and(eq(schema.leads.tenantId, tenantId), eq(schema.leads.externalId, `00QBL${n}`))),
  );

const latest = async (platform: string, metric: string) => {
  const rows = await asMaint((tx) =>
    tx
      .select()
      .from(schema.baselineSnapshots)
      .where(
        and(
          eq(schema.baselineSnapshots.tenantId, tenantId),
          eq(schema.baselineSnapshots.platform, platform),
          eq(schema.baselineSnapshots.metric, metric),
        ),
      ),
  );
  return rows.sort((a, b) => b.version - a.version)[0]!;
};

beforeAll(async () => {
  tenantId = await asMaint(async (tx) => {
    const [t] = await tx.insert(schema.tenants).values({ name: 'Ledger fixture', slug: SLUG, timezone: 'America/New_York' }).returning();
    return t!.id;
  });
  await asMaint(async (tx) => {
    await tx.insert(schema.funnelStages).values([
      { tenantId, position: 1, key: 'lead', label: 'Lead', source: 'leads' },
      { tenantId, position: 2, key: 'mql', label: 'MQL', source: 'qualified_leads' },
      { tenantId, position: 3, key: 'uw_approved', label: 'UW approved' },
      { tenantId, position: 4, key: 'funded', label: 'Funded', countsValue: true },
    ]);
    await tx.insert(schema.engagementTargets).values({ tenantId, platform: 'google_ads', monthIndex: 1, costPerFundedDeal: '4000' });
    await tx.insert(schema.dailyMetrics).values({ tenantId, platform: 'google_ads', date: '2026-08-10', spend: '1000' });
    await tx.insert(schema.leads).values([
      lead(1, { channel: 'google_ads', clickIdType: 'google_ads', clickId: 'g1', mqlVerdict: 'qualified', leadSource: 'Google' }),
      lead(2, { channel: 'google_ads', clickIdType: 'google_ads', clickId: 'g2', mqlVerdict: 'qualified', leadSource: 'Google' }),
      lead(3, { channel: 'google_ads', clickIdType: 'google_ads', clickId: 'g3', leadSource: 'Google' }),
      lead(4, { channel: 'google_ads', clickIdType: 'google_ads', clickId: 'g4', leadSource: 'Google' }),
      lead(5, { leadSource: 'Website' }),
    ]);
  });
  await freezeChannelFigures({ tenantId, months: [MONTH], by: 'test', reason: 'audited', now: NOW });
});

afterAll(async () => {
  await asMaint((tx) => tx.delete(schema.tenants).where(eq(schema.tenants.id, tenantId)));
});

describe('the lead recording', () => {
  it('is written with the freeze, one row per lead of the month', async () => {
    const rows = await asMaint((tx) => tx.select().from(schema.baselineLeads).where(eq(schema.baselineLeads.tenantId, tenantId)));
    expect(rows.map((r) => r.externalId).sort()).toEqual(['00QBL1', '00QBL2', '00QBL3', '00QBL4', '00QBL5']);
    expect((await latest('google_ads', 'stage:lead')).value).toBe('4.0000');
  });

  it('is append-only, even for the role that writes it', async () => {
    const error = await withJobTenant(tenantId, (tx) =>
      tx.update(schema.baselineLeads).set({ counted: false }).where(eq(schema.baselineLeads.tenantId, tenantId)),
    ).catch((e: unknown) => e as { code?: string; cause?: { code?: string } });
    expect((error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code).toBe('42501');
  });

  it('leaves an unchanged month alone', async () => {
    const outcomes = await autoCorrectLeadFigures(tenantId, NOW);
    expect(outcomes).toEqual([{ month: MONTH, status: 'unchanged', detail: expect.any(String) }]);
  });
});

describe('a lead the code moved', () => {
  it('is not proven, and the daily job leaves the month for a person', async () => {
    // The channel rules moved lead 4: its Salesforce fields are as recorded.
    await setLead(4, { channel: 'meta' });
    const proofs = await withJobTenant(tenantId, (tx) => leadFigureProofs(tx, tenantId, MONTH));
    const google = proofs.get('google_ads|stage:lead')!;
    expect(google.moves).toEqual([
      { externalId: '00QBL4', change: 'left', proven: false, why: expect.stringContaining('the code moved it') },
    ]);
    expect(isProvenLeadChange(google, 4, 3)).toBe(false);

    const [outcome] = await autoCorrectLeadFigures(tenantId, LATER);
    expect(outcome!.status).toBe('deferred');
    expect(outcome!.detail).toContain('00QBL4');
    expect((await latest('google_ads', 'stage:lead')).version).toBe(1);
    await setLead(4, { channel: 'google_ads' });
  });
});

describe('a merge in Salesforce', () => {
  it('is proven lead by lead and restated by the daily job, with the leads named', async () => {
    // Lead 2 merged into lead 1: the loser is marked and excluded, as the sync does.
    await setLead(2, { mergedInto: '00QBL1', excludedReason: 'merged' });
    const proofs = await withJobTenant(tenantId, (tx) => leadFigureProofs(tx, tenantId, MONTH));
    for (const metric of ['stage:lead', 'stage:mql']) {
      const p = proofs.get(`google_ads|${metric}`)!;
      expect(p.moves).toEqual([
        { externalId: '00QBL2', change: 'left', proven: true, why: 'merged into 00QBL1 in Salesforce' },
      ]);
      expect(isProvenLeadChange(p, p.frozen, p.now)).toBe(true);
    }

    const [outcome] = await autoCorrectLeadFigures(tenantId, LATER);
    expect(outcome!.status).toBe('corrected');
    const leads = await latest('google_ads', 'stage:lead');
    expect([leads.version, leads.value, leads.frozenBy]).toEqual([2, '3.0000', 'daily-job']);
    expect(leads.reason).toContain('00QBL2 left (merged into 00QBL1 in Salesforce)');
    expect((await latest('google_ads', 'stage:mql')).value).toBe('1.0000');
    // Direct & other did not move, so it keeps its version.
    expect((await latest('unattributed', 'stage:lead')).version).toBe(1);

    // Recorded afresh: the next run finds nothing to do.
    const [again] = await autoCorrectLeadFigures(tenantId, new Date('2026-09-25T08:00:00Z'));
    expect(again!.status).toBe('unchanged');
  });

  it('proves a lead the merge moved into the month from outside it', async () => {
    // A September lead absorbs lead 5 and takes its August creation date.
    await asMaint((tx) =>
      tx.insert(schema.leads).values({
        tenantId,
        externalId: '00QBL9',
        createdAt: new Date('2026-08-15T15:00:00Z'),
        createdOn: '2026-08-15',
        leadSource: 'Website',
      }),
    );
    await setLead(5, { mergedInto: '00QBL9', excludedReason: 'merged' });
    const proofs = await withJobTenant(tenantId, (tx) => leadFigureProofs(tx, tenantId, MONTH));
    const direct = proofs.get('unattributed|stage:lead')!;
    expect(direct.moves).toEqual(
      expect.arrayContaining([
        { externalId: '00QBL5', change: 'left', proven: true, why: 'merged into 00QBL9 in Salesforce' },
        { externalId: '00QBL9', change: 'entered', proven: true, why: 'absorbed 00QBL5 in a Salesforce merge' },
      ]),
    );
    expect(isProvenLeadChange(direct, 1, 1)).toBe(true);
  });
});
