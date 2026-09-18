/**
 * The writer, against a real Postgres.
 *
 * These run through `withJobTenant`, so they exercise the ingestion role's
 * policies at the same time — a write that the policies would refuse fails here
 * rather than in production at 3am.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema, withJobTenant, type Database } from '@zeeraa/db';
import type { LeadRow, OpportunityRow, StageEventRow } from '@zeeraa/connectors';
import {
  applyReconciliation,
  upsertLeads,
  upsertOpportunities,
  upsertOpportunityClickIds,
  upsertStageEvents,
} from '../src/salesforce/writer';
import { openSyncRun } from '../src/salesforce/sync';

const OWNER_URL =
  process.env.DATABASE_URL_OWNER ?? 'postgres://zeeraa_owner:zeeraa_owner@localhost:5433/zeeraa';
const JOBS_URL =
  process.env.DATABASE_URL_JOBS ??
  'postgres://zeeraa_jobs_runner:zeeraa_jobs_runner@localhost:5433/zeeraa';

const ownerSql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
const owner = drizzle(ownerSql, { schema }) as unknown as Database;
const jobsSql = postgres(JOBS_URL, { max: 2, prepare: false, onnotice: () => {} });
const jobs = drizzle(jobsSql, { schema }) as unknown as Database;

let tenantId: string;
let syncRunId: string;

const BAR = { minMonthsInBusiness: 12, minMonthlyRevenue: 10_000, revenueDisagreementTolerance: 0.1 };

function lead(overrides: Partial<LeadRow> = {}): LeadRow {
  return {
    externalId: '00Q1',
    createdAt: new Date('2026-08-01T12:00:00Z'),
    mqlVerdict: null,
    mqlUndeterminableReason: null,
    clickId: 'gclid-1',
    clickIdType: 'google_ads',
    utmSource: 'google',
    utmMedium: null,
    utmCampaign: null,
    utmContent: null,
    utmTerm: null,
    landingPage: null,
    selfReportedRevenue: 25_000,
    selfReportedAnnualRevenue: null,
    selfReportedTimeInBusiness: 36,
    industry: null,
    state: 'NY',
    isConverted: true,
    convertedOpportunityId: '0061',
    mergedInto: null,
    ...overrides,
  };
}

function opportunity(overrides: Partial<OpportunityRow> = {}): OpportunityRow {
  return {
    externalId: '0061',
    leadExternalId: '00Q1',
    createdAt: new Date('2026-08-01T12:00:00Z'),
    currentStage: 'Underwriting',
    amount: 50_000,
    fundedAmount: null,
    declineReason: null,
    industry: null,
    state: 'NY',
    ...overrides,
  };
}

beforeAll(async () => {
  await ownerSql.begin(async (tx) => {
    await tx`select set_config('app.maintenance','on',true)`;
    const [t] = await tx`
      insert into tenants (name, slug) values ('Writer Test', ${'writer-' + Date.now()})
      returning id
    `;
    tenantId = t!.id as string;
    const [run] = await tx`
      insert into sync_runs (tenant_id, platform, trigger, status)
      values (${tenantId}, 'salesforce', 'test', 'running') returning id
    `;
    syncRunId = run!.id as string;
  });
});

beforeEach(async () => {
  await ownerSql.begin(async (tx) => {
    await tx`select set_config('app.maintenance','on',true)`;
    await tx`delete from stage_events where tenant_id = ${tenantId}`;
    await tx`delete from opportunity_click_ids where tenant_id = ${tenantId}`;
    await tx`delete from opportunities where tenant_id = ${tenantId}`;
    await tx`delete from leads where tenant_id = ${tenantId}`;
  });
});

afterAll(async () => {
  await ownerSql.begin(async (tx) => {
    await tx`select set_config('app.maintenance','on',true)`;
    await tx`delete from tenants where id = ${tenantId}`;
  });
  await Promise.all([ownerSql.end(), jobsSql.end()]);
});

async function readLeads() {
  return withJobTenant(tenantId, (tx) => tx.select().from(schema.leads), jobs);
}

describe('leads', () => {
  it('upserts rather than appending', async () => {
    // A sync re-reads a trailing window every run. Appending would multiply
    // every record by the number of runs that saw it.
    await withJobTenant(tenantId, (tx) => upsertLeads(tx, tenantId, [lead()], syncRunId, BAR), jobs);
    await withJobTenant(
      tenantId,
      (tx) => upsertLeads(tx, tenantId, [lead({ state: 'NJ' })], syncRunId, BAR),
      jobs,
    );

    const rows = await readLeads();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('NJ');
  });

  it('stores both revenue figures and flags a disagreement', async () => {
    await withJobTenant(
      tenantId,
      (tx) =>
        upsertLeads(
          tx,
          tenantId,
          [lead({ selfReportedRevenue: 15_000, selfReportedAnnualRevenue: 15_000 })],
          syncRunId,
          BAR,
        ),
      jobs,
    );
    const [row] = await readLeads();
    expect(Number(row?.selfReportedRevenue)).toBe(15_000);
    expect(Number(row?.selfReportedAnnualRevenue)).toBe(15_000);
    // $15k/month against $15k/year is the classic mistyped field.
    expect(row?.revenueFiguresDisagree).toBe(true);
  });

  it('keeps a stored MQL verdict when a re-upsert carries none', async () => {
    // `upsertLeads` takes the bar optionally, so a caller can re-write a lead
    // without judging it. A null verdict there means "not assessed", and
    // overwriting with it would quietly turn a measured MQL into a gap — the
    // funnel would show the stage shrinking with no cause anybody could name.
    await withJobTenant(
      tenantId,
      (tx) =>
        upsertLeads(
          tx,
          tenantId,
          [lead({ mqlVerdict: 'undeterminable', mqlUndeterminableReason: 'a band spanning the bar' })],
          syncRunId,
          BAR,
        ),
      jobs,
    );
    await withJobTenant(
      tenantId,
      (tx) =>
        upsertLeads(
          tx,
          tenantId,
          [lead({ state: 'NJ', mqlVerdict: null, mqlUndeterminableReason: null })],
          syncRunId,
        ),
      jobs,
    );

    const [row] = await readLeads();
    // The rest of the record still updates; only the judgement is preserved.
    expect(row?.state).toBe('NJ');
    expect(row?.mqlVerdict).toBe('undeterminable');
    expect(row?.mqlUndeterminableReason).toBe('a band spanning the bar');
  });

  it('replaces the reason along with the verdict it belongs to', async () => {
    // The reason is not coalesced on its own: a lead that becomes qualified
    // must not keep the explanation of why it once could not be judged.
    await withJobTenant(
      tenantId,
      (tx) =>
        upsertLeads(
          tx,
          tenantId,
          [lead({ mqlVerdict: 'undeterminable', mqlUndeterminableReason: 'no revenue answer' })],
          syncRunId,
          BAR,
        ),
      jobs,
    );
    await withJobTenant(
      tenantId,
      (tx) =>
        upsertLeads(
          tx,
          tenantId,
          [lead({ mqlVerdict: 'qualified', mqlUndeterminableReason: null })],
          syncRunId,
          BAR,
        ),
      jobs,
    );

    const [row] = await readLeads();
    expect(row?.mqlVerdict).toBe('qualified');
    expect(row?.mqlUndeterminableReason).toBeNull();
  });

  it('does not flag figures that agree', async () => {
    await withJobTenant(
      tenantId,
      (tx) =>
        upsertLeads(
          tx,
          tenantId,
          [lead({ selfReportedRevenue: 15_000, selfReportedAnnualRevenue: 180_000 })],
          syncRunId,
          BAR,
        ),
      jobs,
    );
    const [row] = await readLeads();
    expect(row?.revenueFiguresDisagree).toBe(false);
  });
});

describe('stage events', () => {
  const base: StageEventRow = {
    opportunityExternalId: '0061',
    stage: 'uw_approved',
    occurredAt: new Date('2026-08-05T09:00:00Z'),
    origin: 'observed',
  };

  it('is idempotent on a re-read of the same record', async () => {
    for (let i = 0; i < 3; i += 1) {
      await withJobTenant(
        tenantId,
        (tx) => upsertStageEvents(tx, tenantId, [base], syncRunId),
        jobs,
      );
    }
    const rows = await withJobTenant(
      tenantId,
      (tx) => tx.select().from(schema.stageEvents),
      jobs,
    );
    expect(rows).toHaveLength(1);
  });

  it('keeps a corrected timestamp as a separate row rather than overwriting', async () => {
    // The funnel takes the earliest occurrence; keeping both makes the
    // correction visible instead of silently rewriting history.
    await withJobTenant(tenantId, (tx) => upsertStageEvents(tx, tenantId, [base], syncRunId), jobs);
    await withJobTenant(
      tenantId,
      (tx) =>
        upsertStageEvents(
          tx,
          tenantId,
          [{ ...base, occurredAt: new Date('2026-08-04T09:00:00Z') }],
          syncRunId,
        ),
      jobs,
    );
    const rows = await withJobTenant(tenantId, (tx) => tx.select().from(schema.stageEvents), jobs);
    expect(rows).toHaveLength(2);
  });

  it('persists the computed origin', async () => {
    await withJobTenant(
      tenantId,
      (tx) =>
        upsertStageEvents(
          tx,
          tenantId,
          [{ ...base, stage: 'mql', origin: 'computed' }],
          syncRunId,
        ),
      jobs,
    );
    const [row] = await withJobTenant(
      tenantId,
      (tx) => tx.select().from(schema.stageEvents).where(eq(schema.stageEvents.stage, 'mql')),
      jobs,
    );
    expect(row?.origin).toBe('computed');
  });
});

describe('opportunities', () => {
  it('does not blank the lead link when the opportunity query omits it', async () => {
    // The opportunity query has no idea which lead converted into it. A plain
    // assignment would erase the link the lead sync established.
    await withJobTenant(
      tenantId,
      (tx) => upsertOpportunities(tx, tenantId, [opportunity()], syncRunId),
      jobs,
    );
    await withJobTenant(
      tenantId,
      (tx) =>
        upsertOpportunities(
          tx,
          tenantId,
          [opportunity({ leadExternalId: null, currentStage: 'Funded' })],
          syncRunId,
        ),
      jobs,
    );
    const [row] = await withJobTenant(
      tenantId,
      (tx) => tx.select().from(schema.opportunities),
      jobs,
    );
    expect(row?.leadExternalId).toBe('00Q1');
    expect(row?.currentStage).toBe('Funded');
  });
});

describe('click IDs', () => {
  it('keeps the two routes apart so neither overwrites the other', async () => {
    await withJobTenant(
      tenantId,
      (tx) =>
        upsertOpportunityClickIds(
          tx,
          tenantId,
          [
            { opportunityExternalId: '0061', platform: 'google_ads', clickId: 'from-field', source: 'opportunity_field' },
            { opportunityExternalId: '0061', platform: 'google_ads', clickId: 'from-lead', source: 'lead_conversion' },
          ],
          syncRunId,
        ),
      jobs,
    );
    const rows = await withJobTenant(
      tenantId,
      (tx) => tx.select().from(schema.opportunityClickIds),
      jobs,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.source).sort()).toEqual(['lead_conversion', 'opportunity_field']);
  });

  it('is safe to re-run', async () => {
    const row = {
      opportunityExternalId: '0061',
      platform: 'google_ads',
      clickId: 'from-lead',
      source: 'lead_conversion' as const,
    };
    for (let i = 0; i < 3; i += 1) {
      await withJobTenant(
        tenantId,
        (tx) => upsertOpportunityClickIds(tx, tenantId, [row], syncRunId),
        jobs,
      );
    }
    const rows = await withJobTenant(
      tenantId,
      (tx) => tx.select().from(schema.opportunityClickIds),
      jobs,
    );
    expect(rows).toHaveLength(1);
  });
});

describe('reconciliation', () => {
  it('deletes a genuinely deleted lead', async () => {
    await withJobTenant(tenantId, (tx) => upsertLeads(tx, tenantId, [lead()], syncRunId, BAR), jobs);
    const counts = await withJobTenant(
      tenantId,
      (tx) => applyReconciliation(tx, tenantId, 'Lead', { deletedIds: ['00Q1'], merges: [] }),
      jobs,
    );
    expect(counts.deleted).toBe(1);
    expect(await readLeads()).toHaveLength(0);
  });

  it('carries a merged lead’s click ID to the survivor instead of losing it', async () => {
    // The whole point: a merge looks like a deletion but is the opposite. The
    // loser's click is what produced the deal, and it belongs to the survivor.
    await withJobTenant(
      tenantId,
      (tx) =>
        upsertLeads(
          tx,
          tenantId,
          [
            lead({ externalId: '00Q-loser', clickId: 'gclid-loser', clickIdType: 'google_ads' }),
            lead({ externalId: '00Q-survivor', clickId: null, clickIdType: null }),
          ],
          syncRunId,
          BAR,
        ),
      jobs,
    );

    const counts = await withJobTenant(
      tenantId,
      (tx) =>
        applyReconciliation(tx, tenantId, 'Lead', {
          deletedIds: [],
          merges: [{ loserId: '00Q-loser', survivorId: '00Q-survivor' }],
        }),
      jobs,
    );

    expect(counts).toMatchObject({ deleted: 0, merged: 1, clickIdsMoved: 1 });

    const rows = await readLeads();
    const loser = rows.find((r) => r.externalId === '00Q-loser');
    const survivor = rows.find((r) => r.externalId === '00Q-survivor');
    // The loser is marked, not deleted.
    expect(loser?.mergedInto).toBe('00Q-survivor');
    expect(survivor?.clickId).toBe('gclid-loser');
  });

  it('does not overwrite a click ID the survivor already had', async () => {
    await withJobTenant(
      tenantId,
      (tx) =>
        upsertLeads(
          tx,
          tenantId,
          [
            lead({ externalId: '00Q-loser', clickId: 'gclid-loser' }),
            lead({ externalId: '00Q-survivor', clickId: 'gclid-survivor' }),
          ],
          syncRunId,
          BAR,
        ),
      jobs,
    );
    const counts = await withJobTenant(
      tenantId,
      (tx) =>
        applyReconciliation(tx, tenantId, 'Lead', {
          deletedIds: [],
          merges: [{ loserId: '00Q-loser', survivorId: '00Q-survivor' }],
        }),
      jobs,
    );
    expect(counts.clickIdsMoved).toBe(0);
    const survivor = (await readLeads()).find((r) => r.externalId === '00Q-survivor');
    expect(survivor?.clickId).toBe('gclid-survivor');
  });

  it('is safe to apply the same merge twice', async () => {
    await withJobTenant(
      tenantId,
      (tx) =>
        upsertLeads(
          tx,
          tenantId,
          [lead({ externalId: '00Q-loser' }), lead({ externalId: '00Q-survivor', clickId: null })],
          syncRunId,
          BAR,
        ),
      jobs,
    );
    const merges = [{ loserId: '00Q-loser', survivorId: '00Q-survivor' }];
    await withJobTenant(
      tenantId,
      (tx) => applyReconciliation(tx, tenantId, 'Lead', { deletedIds: [], merges }),
      jobs,
    );
    const second = await withJobTenant(
      tenantId,
      (tx) => applyReconciliation(tx, tenantId, 'Lead', { deletedIds: [], merges }),
      jobs,
    );
    // The survivor already has the click ID, so nothing moves the second time.
    expect(second.clickIdsMoved).toBe(0);
    expect(await readLeads()).toHaveLength(2);
  });
});
