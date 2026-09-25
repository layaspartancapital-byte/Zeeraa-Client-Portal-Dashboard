/**
 * Local dates, exclusions and corrections, against a real Postgres.
 *
 * Through `withJobTenant`, so the ingestion role's policies are exercised with
 * them: a rule the policies would refuse fails here, not silently in the
 * nightly job.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { leadsCreatedIn, schema, stageEventsIn, submissionsIn, withJobTenant, type Database } from '@zeeraa/db';
import type { OpportunityRow, StageEventRow } from '@zeeraa/connectors';
import { upsertOpportunities, upsertStageEvents } from '../src/salesforce/writer';
import {
  applyLeadSourceExclusions,
  applyStageCorrections,
  applyStageExclusions,
  applyStageMerges,
  parseStageCorrections,
  parseStageMerges,
  parseStageExclusions,
} from '../src/salesforce/stage-rules';

const OWNER_URL =
  process.env.DATABASE_URL_OWNER ?? 'postgres://zeeraa_owner:zeeraa_owner@localhost:5433/zeeraa';
const JOBS_URL =
  process.env.DATABASE_URL_JOBS ??
  'postgres://zeeraa_jobs_runner:zeeraa_jobs_runner@localhost:5433/zeeraa';

const ownerSql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
const jobsSql = postgres(JOBS_URL, { max: 2, prepare: false, onnotice: () => {} });
const jobs = drizzle(jobsSql, { schema }) as unknown as Database;

let tenantId: string;
let syncRunId: string;

const RENEWALS = parseStageExclusions({
  rules: [{ reason: 'renewal', dealTypes: ['Renewal', 'Win Back'], stages: ['funded'] }],
});

function opportunity(externalId: string, dealType: string | null): OpportunityRow {
  return {
    externalId,
    leadExternalId: null,
    createdAt: new Date('2026-05-13T10:00:00Z'),
    currentStage: 'Funded',
    amount: 10_000,
    fundedAmount: 10_000,
    dealType,
    declineReason: null,
    industry: null,
    state: null,
    isClosed: true,
  };
}

function event(opportunityExternalId: string, stage: string, at: string): StageEventRow {
  return { opportunityExternalId, stage, occurredAt: new Date(at), origin: 'observed' };
}

const run = <T>(fn: (tx: Database) => Promise<T>) => withJobTenant(tenantId, fn, jobs);

const readEvents = () =>
  run((tx) =>
    tx
      .select()
      .from(schema.stageEvents)
      .where(eq(schema.stageEvents.tenantId, tenantId)),
  );

beforeAll(async () => {
  await ownerSql.begin(async (tx) => {
    await tx`select set_config('app.maintenance','on',true)`;
    const [t] = await tx`
      insert into tenants (name, slug, timezone)
      values ('Stage Rules Test', ${'stage-rules-' + Date.now()}, 'America/New_York')
      returning id
    `;
    tenantId = t!.id as string;
    const [r] = await tx`
      insert into sync_runs (tenant_id, platform, trigger, status)
      values (${tenantId}, 'salesforce', 'test', 'running') returning id
    `;
    syncRunId = r!.id as string;
  });
});

beforeEach(async () => {
  await ownerSql.begin(async (tx) => {
    await tx`select set_config('app.maintenance','on',true)`;
    await tx`delete from stage_events where tenant_id = ${tenantId}`;
    await tx`delete from leads where tenant_id = ${tenantId}`;
    await tx`delete from opportunities where tenant_id = ${tenantId}`;
  });
});

afterAll(async () => {
  await ownerSql.begin(async (tx) => {
    await tx`select set_config('app.maintenance','on',true)`;
    await tx`delete from tenants where id = ${tenantId}`;
  });
  await Promise.all([ownerSql.end(), jobsSql.end()]);
});

describe('local dates', () => {
  it('files an evening event under the tenant-local day, not the UTC one', async () => {
    // 9:30pm Eastern on 31 August is 01:30 UTC on 1 September. Bucketed by
    // the UTC day, this deal funded in September.
    await run((tx) =>
      upsertStageEvents(tx, tenantId, [event('006A', 'funded', '2026-09-01T01:30:00Z')], syncRunId),
    );
    const [row] = await readEvents();
    expect(row!.occurredOn).toBe('2026-08-31');

    const august = await run((tx) =>
      tx
        .select()
        .from(schema.stageEvents)
        .where(
          and(
            eq(schema.stageEvents.tenantId, tenantId),
            stageEventsIn({ start: '2026-08-01', end: '2026-08-31' }),
          ),
        ),
    );
    expect(august).toHaveLength(1);
  });
});

describe('stage exclusions', () => {
  it('excludes a renewal reaching Funded and nothing else about it', async () => {
    await run(async (tx) => {
      await upsertOpportunities(
        tx,
        tenantId,
        [opportunity('006R', 'Renewal'), opportunity('006N', 'New Business')],
        syncRunId,
      );
      await upsertStageEvents(
        tx,
        tenantId,
        [
          event('006R', 'funded', '2026-08-12T15:00:00Z'),
          event('006R', 'uw_approved', '2026-08-11T15:00:00Z'),
          event('006N', 'funded', '2026-08-12T16:00:00Z'),
        ],
        syncRunId,
      );
      return applyStageExclusions(tx, tenantId, RENEWALS);
    });

    const rows = await readEvents();
    const reason = (opp: string, stage: string) =>
      rows.find((r) => r.opportunityExternalId === opp && r.stage === stage)?.excludedReason;
    expect(reason('006R', 'funded')).toBe('renewal');
    expect(reason('006R', 'uw_approved')).toBeNull();
    expect(reason('006N', 'funded')).toBeNull();
  });

  it("with '*', excludes the deal at every stage and the lead that became it", async () => {
    const everywhere = parseStageExclusions({
      rules: [{ reason: 'renewal', dealTypes: ['Renewal'], stages: ['*'] }],
    });
    await run(async (tx) => {
      await upsertOpportunities(
        tx,
        tenantId,
        [opportunity('006R', 'Renewal'), opportunity('006N', 'New Business')],
        syncRunId,
      );
      await tx.insert(schema.leads).values([
        { tenantId, externalId: '00QR', createdAt: new Date('2026-08-01T15:00:00Z'), createdOn: '2026-08-01', convertedOpportunityId: '006R' },
        { tenantId, externalId: '00QN', createdAt: new Date('2026-08-01T15:00:00Z'), createdOn: '2026-08-01', convertedOpportunityId: '006N' },
      ]);
      await upsertStageEvents(
        tx,
        tenantId,
        [
          event('006R', 'application', '2026-08-01T16:00:00Z'),
          event('006R', 'uw_approved', '2026-08-11T15:00:00Z'),
          event('006R', 'funded', '2026-08-12T15:00:00Z'),
          event('006N', 'application', '2026-08-01T16:00:00Z'),
        ],
        syncRunId,
      );
      await applyStageExclusions(tx, tenantId, everywhere);
    });

    const events = await readEvents();
    expect(events.filter((e) => e.opportunityExternalId === '006R').map((e) => e.excludedReason)).toEqual([
      'renewal',
      'renewal',
      'renewal',
    ]);
    expect(events.find((e) => e.opportunityExternalId === '006N')!.excludedReason).toBeNull();

    const leads = await run((tx) =>
      tx.select().from(schema.leads).where(eq(schema.leads.tenantId, tenantId)),
    );
    expect(leads.find((l) => l.externalId === '00QR')!.excludedReason).toBe('renewal');
    expect(leads.find((l) => l.externalId === '00QN')!.excludedReason).toBeNull();

    // And the period predicate is what drops it.
    const counted = await run((tx) =>
      tx
        .select()
        .from(schema.leads)
        .where(and(eq(schema.leads.tenantId, tenantId), leadsCreatedIn({ start: '2026-08-01', end: '2026-08-31' }))),
    );
    expect(counted.map((l) => l.externalId)).toEqual(['00QN']);
  });

  it('excludes a lead merged into another, which is the same merchant twice', async () => {
    // September 2026 counted 45 merged duplicates: marked `merged_into` by the
    // reconciliation, then counted anyway.
    await run(async (tx) => {
      await tx.insert(schema.leads).values([
        { tenantId, externalId: '00QM', createdAt: new Date('2026-09-18T15:00:00Z'), createdOn: '2026-09-18', mergedInto: '00QS' },
        { tenantId, externalId: '00QS', createdAt: new Date('2026-09-18T14:00:00Z'), createdOn: '2026-09-18' },
      ]);
      await applyStageExclusions(tx, tenantId, RENEWALS);
    });
    const counted = await run((tx) =>
      tx
        .select()
        .from(schema.leads)
        .where(and(eq(schema.leads.tenantId, tenantId), leadsCreatedIn({ start: '2026-09-18', end: '2026-09-18' }))),
    );
    expect(counted.map((l) => l.externalId)).toEqual(['00QS']);

    // And a recompute, which clears every reason first, puts it back.
    await run((tx) => applyStageExclusions(tx, tenantId, []));
    const [loser] = await run((tx) =>
      tx.select().from(schema.leads).where(and(eq(schema.leads.tenantId, tenantId), eq(schema.leads.externalId, '00QM'))),
    );
    expect(loser!.excludedReason).toBe('merged');
  });

  it("with '*', also drops the renewal's submissions from every offer rate", async () => {
    const everywhere = parseStageExclusions({
      rules: [{ reason: 'renewal', dealTypes: ['Renewal'], stages: ['*'] }],
    });
    await run(async (tx) => {
      await upsertOpportunities(
        tx,
        tenantId,
        [opportunity('006SR', 'Renewal'), opportunity('006SN', 'New Business')],
        syncRunId,
      );
      await tx.insert(schema.submissions).values([
        { tenantId, externalId: 'a0SR', opportunityExternalId: '006SR', lenderName: 'L', status: 'Declined', outcome: 'declined', submittedAt: new Date('2026-07-10T15:00:00Z'), submittedOn: '2026-07-10' },
        { tenantId, externalId: 'a0SN', opportunityExternalId: '006SN', lenderName: 'L', status: 'Declined', outcome: 'declined', submittedAt: new Date('2026-07-10T15:00:00Z'), submittedOn: '2026-07-10' },
      ]);
      await applyStageExclusions(tx, tenantId, everywhere);
    });
    const counted = await run((tx) =>
      tx
        .select({ externalId: schema.submissions.externalId })
        .from(schema.submissions)
        .where(and(eq(schema.submissions.tenantId, tenantId), submissionsIn({ start: '2026-07-01', end: '2026-07-31' }))),
    );
    expect(counted.map((r) => r.externalId)).toEqual(['a0SN']);
  });

  it('matches the deal type case-insensitively and trimmed', async () => {
    await run(async (tx) => {
      await upsertOpportunities(tx, tenantId, [opportunity('006W', '  win back ')], syncRunId);
      await upsertStageEvents(tx, tenantId, [event('006W', 'funded', '2026-08-12T15:00:00Z')], syncRunId);
      await applyStageExclusions(tx, tenantId, RENEWALS);
    });
    const [row] = await readEvents();
    expect(row!.excludedReason).toBe('renewal');
  });

  it('restores an event once its rule is removed', async () => {
    await run(async (tx) => {
      await upsertOpportunities(tx, tenantId, [opportunity('006R', 'Renewal')], syncRunId);
      await upsertStageEvents(tx, tenantId, [event('006R', 'funded', '2026-08-12T15:00:00Z')], syncRunId);
      await applyStageExclusions(tx, tenantId, RENEWALS);
      await applyStageExclusions(tx, tenantId, []);
    });
    const [row] = await readEvents();
    expect(row!.excludedReason).toBeNull();
  });

  it('refuses a malformed rule rather than excluding nothing', () => {
    expect(() => parseStageExclusions({ rules: [{ reason: 'renewal', dealTypes: [], stages: ['funded'] }] })).toThrow();
    expect(() => parseStageExclusions({ rule: [] })).toThrow();
    expect(parseStageExclusions(undefined)).toEqual([]);
  });
});

describe('stage corrections', () => {
  const MAY = parseStageCorrections({
    corrections: [
      { opportunity: '006E', stage: 'funded', month: '2026-05', source: 'Client, 23 Sep 2026' },
    ],
  });

  it("replaces the CRM's date with the month, and says the day is unknown", async () => {
    await run(async (tx) => {
      await upsertStageEvents(tx, tenantId, [event('006E', 'funded', '2026-09-01T21:43:42Z')], syncRunId);
      await applyStageCorrections(tx, tenantId, MAY);
    });

    const rows = (await readEvents()).filter((r) => r.stage === 'funded');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      origin: 'corrected',
      occurredOn: '2026-05-01',
      occurredPrecision: 'month',
      correctionSource: 'Client, 23 Sep 2026',
    });
    // The first instant of May in New York, not UTC midnight.
    expect(rows[0]!.occurredAt.toISOString()).toBe('2026-05-01T04:00:00.000Z');
  });

  it('holds when the sync writes the CRM date back', async () => {
    // The CRM keeps stamping 1 September; the sync re-upserts it whenever the
    // deal is modified, and the correction has to win every time.
    for (let i = 0; i < 2; i += 1) {
      await run(async (tx) => {
        await upsertStageEvents(tx, tenantId, [event('006E', 'funded', '2026-09-01T21:43:42Z')], syncRunId);
        await applyStageCorrections(tx, tenantId, MAY);
      });
    }
    const rows = (await readEvents()).filter((r) => r.stage === 'funded');
    expect(rows.map((r) => r.origin)).toEqual(['corrected']);
  });

  it('drops a correction removed from config', async () => {
    await run(async (tx) => {
      await applyStageCorrections(tx, tenantId, MAY);
      await applyStageCorrections(tx, tenantId, []);
    });
    expect(await readEvents()).toHaveLength(0);
  });

  it('refuses a correction with no source, or a day where a month is asked for', () => {
    expect(() =>
      parseStageCorrections({ corrections: [{ opportunity: '006E', stage: 'funded', month: '2026-05' }] }),
    ).toThrow(/source/);
    expect(() =>
      parseStageCorrections({
        corrections: [{ opportunity: '006E', stage: 'funded', month: '2026-05-13', source: 'x' }],
      }),
    ).toThrow();
  });

  it('is excluded like any other event when it is a renewal', async () => {
    await run(async (tx) => {
      await upsertOpportunities(tx, tenantId, [opportunity('006E', 'Renewal')], syncRunId);
      await applyStageCorrections(tx, tenantId, MAY);
      await applyStageExclusions(tx, tenantId, RENEWALS);
    });
    const [row] = await readEvents();
    expect(row!.excludedReason).toBe('renewal');
  });
});

describe('parseLenderExclusions', () => {
  it('reads the lender ids and the reason', async () => {
    const { parseLenderExclusions } = await import('../src/salesforce/stage-rules');
    expect(
      parseLenderExclusions({ reason: 'test_lender', lenders: [{ id: '001A', name: 'Test Lender' }] }),
    ).toEqual({ reason: 'test_lender', lenderIds: ['001A'] });
    expect(parseLenderExclusions(undefined)).toBeNull();
  });

  it('throws on a malformed row rather than excluding nothing', async () => {
    const { parseLenderExclusions } = await import('../src/salesforce/stage-rules');
    expect(() => parseLenderExclusions({ reason: 'test_lender', lenders: [] })).toThrow();
    expect(() => parseLenderExclusions({ reason: 'test_lender', lenders: [{ name: 'no id' }] })).toThrow();
  });
});

describe('Lead Source exclusions survive the stage exclusions (24 September 2026)', () => {
  it('re-marks an outbound lead after every lead reason is cleared', async () => {
    const exclusion = {
      enabled: true,
      rules: [{ key: 'outbound_zoominfo', label: 'Outbound', leadSources: ['Zoominfo'] }],
      inboundSignalFields: ['LeadSource'],
    };
    await run((tx) =>
      tx.insert(schema.leads).values([
        { tenantId, externalId: '00QZ', createdAt: new Date('2026-08-10T15:00:00Z'), createdOn: '2026-08-10', leadSource: 'Zoominfo' },
        { tenantId, externalId: '00QW', createdAt: new Date('2026-08-10T15:00:00Z'), createdOn: '2026-08-10', leadSource: 'Web' },
      ]),
    );
    // What the sync does, in its order: clear and re-apply the renewal rules, then this.
    await run((tx) => applyStageExclusions(tx, tenantId, RENEWALS));
    expect(await run((tx) => applyLeadSourceExclusions(tx, tenantId, exclusion))).toBe(1);
    await run((tx) => applyStageExclusions(tx, tenantId, RENEWALS));
    await run((tx) => applyLeadSourceExclusions(tx, tenantId, exclusion));
    const counted = await run((tx) =>
      tx.select({ id: schema.leads.externalId }).from(schema.leads).where(and(eq(schema.leads.tenantId, tenantId), leadsCreatedIn({ start: '2026-08-01', end: '2026-08-31' }))),
    );
    expect(counted.map((r) => r.id)).toEqual(['00QW']);
  });
});

describe('stage merges', () => {
  const MERGE = parseStageMerges({ merges: [{ into: 'uw_approved', from: ['offer'] }] });
  const approvals = async () =>
    (await readEvents())
      .filter((e) => e.stage === 'uw_approved')
      .map((e) => ({ opp: e.opportunityExternalId, at: e.occurredAt.toISOString(), derived: e.derivedFrom, excluded: e.excludedReason }))
      .sort((a, b) => a.opp.localeCompare(b.opp) || a.at.localeCompare(b.at));

  it('approves a deal at its offer where the offer came first, or alone, and not otherwise', async () => {
    await run(async (tx) => {
      await upsertStageEvents(
        tx,
        tenantId,
        [
          // Offer on 30 July, approval stamped on 2 August: approved on 30 July.
          event('006A', 'offer', '2026-07-30T15:00:00Z'),
          event('006A', 'uw_approved', '2026-08-02T15:00:00Z'),
          // Approved first: the later offer is the same step, not a second approval.
          event('006B', 'uw_approved', '2026-07-01T15:00:00Z'),
          event('006B', 'offer', '2026-07-03T15:00:00Z'),
          // An offer and no approval at all; two offers, the first counts.
          event('006C', 'offer', '2026-07-10T15:00:00Z'),
          event('006C', 'offer', '2026-07-20T15:00:00Z'),
        ],
        syncRunId,
      );
      await applyStageMerges(tx, tenantId, MERGE);
    });
    expect(await approvals()).toEqual([
      { opp: '006A', at: '2026-07-30T15:00:00.000Z', derived: 'offer', excluded: null },
      { opp: '006A', at: '2026-08-02T15:00:00.000Z', derived: null, excluded: null },
      { opp: '006B', at: '2026-07-01T15:00:00.000Z', derived: null, excluded: null },
      { opp: '006C', at: '2026-07-10T15:00:00.000Z', derived: 'offer', excluded: null },
    ]);
    // The offers themselves are still stored as offers.
    expect((await readEvents()).filter((e) => e.stage === 'offer')).toHaveLength(4);
  });

  it('recomputes from scratch: running twice changes nothing, and no rule removes what it wrote', async () => {
    await run(async (tx) => {
      await upsertStageEvents(tx, tenantId, [event('006C', 'offer', '2026-07-10T15:00:00Z')], syncRunId);
      await applyStageMerges(tx, tenantId, MERGE);
      await applyStageMerges(tx, tenantId, MERGE);
    });
    expect(await approvals()).toHaveLength(1);
    await run((tx) => applyStageMerges(tx, tenantId, []));
    expect(await approvals()).toEqual([]);
  });

  it('keeps a real approval that lands on a derived one, and the exclusions judge derived events too', async () => {
    await run(async (tx) => {
      await upsertOpportunities(tx, tenantId, [opportunity('006R', 'Renewal')], syncRunId);
      await upsertStageEvents(
        tx,
        tenantId,
        [event('006C', 'offer', '2026-07-10T15:00:00Z'), event('006R', 'offer', '2026-07-11T15:00:00Z')],
        syncRunId,
      );
      await applyStageMerges(tx, tenantId, MERGE);
      // Salesforce later stamps the approval at exactly the offer's moment.
      await upsertStageEvents(tx, tenantId, [event('006C', 'uw_approved', '2026-07-10T15:00:00Z')], syncRunId);
      await applyStageMerges(tx, tenantId, MERGE);
      await applyStageExclusions(
        tx,
        tenantId,
        parseStageExclusions({ rules: [{ reason: 'renewal', dealTypes: ['Renewal'], stages: ['*'] }] }),
      );
    });
    expect(await approvals()).toEqual([
      { opp: '006C', at: '2026-07-10T15:00:00.000Z', derived: null, excluded: null },
      { opp: '006R', at: '2026-07-11T15:00:00.000Z', derived: 'offer', excluded: 'renewal' },
    ]);
  });

  it('refuses a malformed rule rather than merging nothing', () => {
    expect(() => parseStageMerges({ merges: [{ into: 'uw_approved', from: [] }] })).toThrow(/needs an/);
    expect(() => parseStageMerges({ merges: [{ into: 'offer', from: ['offer'] }] })).toThrow(/needs an/);
    expect(parseStageMerges(null)).toEqual([]);
  });
});
