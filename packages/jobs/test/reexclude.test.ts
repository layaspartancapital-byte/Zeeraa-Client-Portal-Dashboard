/**
 * A lead that comes under an exclusion rule after it was ingested — a merge
 * gave it a cold-list creation date — is marked excluded, and the
 * reconciliation explains a stage a deal reached twice when Salesforce's field
 * keeps only the later date (30 October 2026, September's freeze).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema, withJobTenant, type Database } from '@zeeraa/db';
import { parseLeadExclusion, type SalesforceClient } from '@zeeraa/connectors';
import { leadRuleReasons, markLeadsNowExcluded } from '../src/salesforce/reexclude';
import { applyStageExclusions } from '../src/salesforce/stage-rules';
import { classifyIds } from '../src/reconcile';

const OWNER_URL = process.env.DATABASE_URL_OWNER ?? 'postgres://zeeraa_owner:zeeraa_owner@localhost:5433/zeeraa';
const JOBS_URL = process.env.DATABASE_URL_JOBS ?? 'postgres://zeeraa_jobs_runner:zeeraa_jobs_runner@localhost:5433/zeeraa';
const ownerSql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
const jobsSql = postgres(JOBS_URL, { max: 2, prepare: false, onnotice: () => {} });
const jobs = drizzle(jobsSql, { schema }) as unknown as Database;
let tenantId: string;

const config = parseLeadExclusion({
  enabled: true,
  inboundSignalFields: ['LeadSource'],
  rules: [
    {
      key: 'bulk_load',
      label: 'Cold-list bulk load',
      createdBetween: { from: '2026-09-08T00:00:00Z', to: '2026-09-09T00:00:00Z' },
      requireNullLeadSource: true,
    },
  ],
});

/** Answers each rule's query with the leads Salesforce would match now. */
const client = (byClause: (soql: string) => string[]) =>
  ({ query: async (soql: string) => byClause(soql).map((Id) => ({ Id })) }) as unknown as SalesforceClient;

beforeAll(async () => {
  await ownerSql.begin(async (tx) => {
    await tx`select set_config('app.maintenance','on',true)`;
    const [t] = await tx`insert into tenants (name, slug, timezone) values ('Reexclude', ${'reexclude-' + Date.now()}, 'America/New_York') returning id`;
    tenantId = t!.id as string;
    for (const [id, reason] of [['merged-into-cold', null], ['still-inbound', null], ['already-merged', 'merged']] as const) {
      await tx`insert into leads (tenant_id, external_id, created_at, created_on, excluded_reason)
               values (${tenantId}, ${id}, '2026-09-18T15:00:00Z', '2026-09-18', ${reason})`;
    }
  });
});

afterAll(async () => {
  await ownerSql.begin(async (tx) => {
    await tx`select set_config('app.maintenance','on',true)`;
    await tx`delete from tenants where id = ${tenantId}`;
  });
  await Promise.all([ownerSql.end(), jobsSql.end()]);
});

describe('markLeadsNowExcluded', () => {
  it('marks a stored lead Salesforce now places under a rule, and leaves another reason alone', async () => {
    const seen: string[] = [];
    const marked = await withJobTenant(
      tenantId,
      (tx) =>
        markLeadsNowExcluded(
          client((soql) => {
            seen.push(soql);
            return soql.includes('CreatedDate >=') ? ['merged-into-cold', 'already-merged'] : [];
          }),
          tx,
          tenantId,
          config,
          new Date('2026-10-30T13:00:00Z'),
        ),
      jobs,
    );
    expect(marked).toEqual({ bulk_load: 1 });
    expect(seen.every((q) => q.includes('SystemModstamp > 2026-10-30T13:00:00Z'))).toBe(true);
    const rows = await withJobTenant(tenantId, (tx) => tx.select().from(schema.leads).where(eq(schema.leads.tenantId, tenantId)), jobs);
    const reason = Object.fromEntries(rows.map((r) => [r.externalId, r.excludedReason]));
    expect(reason).toEqual({ 'merged-into-cold': 'bulk_load', 'still-inbound': null, 'already-merged': 'merged' });
  });
});

describe('the sync’s exclusion reset', () => {
  it('keeps a reason set from Salesforce’s record while its rule is configured, and clears it once it is not', async () => {
    const reasonOf = async () =>
      (await withJobTenant(tenantId, (tx) => tx.select().from(schema.leads).where(eq(schema.leads.tenantId, tenantId)), jobs)).find(
        (r) => r.externalId === 'merged-into-cold',
      )?.excludedReason;
    await withJobTenant(tenantId, (tx) => applyStageExclusions(tx, tenantId, [], leadRuleReasons(config)), jobs);
    expect(await reasonOf()).toBe('bulk_load');
    await withJobTenant(tenantId, (tx) => applyStageExclusions(tx, tenantId, [], []), jobs);
    expect(await reasonOf()).toBeNull();
  });
});

describe('classifyIds', () => {
  const window = { start: '2026-09-01', end: '2026-09-30' };
  it('explains a deal that reached the stage again later, and still calls an unexplained one drift', () => {
    const recurred = classifyIds('salesforce', 'offer', window, new Set(['a', 'b']), new Set(), [], new Set(), new Set(['a', 'b']));
    expect(recurred.status).toBe('explained');
    expect(recurred.detail).toMatch(/reached it again later/);
    const drift = classifyIds('salesforce', 'offer', window, new Set(['a', 'c']), new Set(), [], new Set(), new Set(['a']));
    expect(drift.status).toBe('drift');
  });
});
