/**
 * The Meta ad-name step (0041), against a real Postgres on the ingestion role.
 *
 * It asks Meta only about ids a Meta lead carries in the configured parameter
 * and that are not named yet, stores what Meta confirms, and does nothing at
 * all without the `landing_url_parameters` row — a parameter is never assumed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema, withJobTenant, type Database } from '@zeeraa/db';
import type { Connection, Connector } from '@zeeraa/connectors';
import { resolveMetaAdNames } from '../src/meta/ad-names';
import type { MetaContext } from '../src/meta/context';

const OWNER_URL =
  process.env.DATABASE_URL_OWNER ?? 'postgres://zeeraa_owner:zeeraa_owner@localhost:5433/zeeraa';
const JOBS_URL =
  process.env.DATABASE_URL_JOBS ??
  'postgres://zeeraa_jobs_runner:zeeraa_jobs_runner@localhost:5433/zeeraa';

const ownerSql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
const jobsSql = postgres(JOBS_URL, { max: 2, prepare: false, onnotice: () => {} });
const jobs = drizzle(jobsSql, { schema }) as unknown as Database;

let tenantId: string;

const asMaintenance = (fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
  ownerSql.begin(async (tx) => {
    await tx`select set_config('app.maintenance','on',true)`;
    await fn(tx);
  });

function contextWith(fetchAdNames: Connector['fetchAdNames']): MetaContext {
  return {
    tenantId,
    connectionId: 'test',
    connection: { tenantId, platform: 'meta' } as Connection,
    connector: { fetchAdNames } as Connector,
  };
}

const run = <T,>(fn: (tx: Database) => Promise<T>) => withJobTenant(tenantId, fn, jobs);

beforeAll(async () => {
  await asMaintenance(async (tx) => {
    const [t] = await tx`insert into tenants (name, slug) values ('Ad names', ${'ad-names-' + Date.now()}) returning id`;
    tenantId = t!.id as string;
  });
});

beforeEach(async () => {
  await asMaintenance(async (tx) => {
    await tx`delete from platform_ads where tenant_id = ${tenantId}`;
    await tx`delete from leads where tenant_id = ${tenantId}`;
    await tx`delete from tenant_config where tenant_id = ${tenantId}`;
    await tx`
      insert into leads (tenant_id, external_id, created_at, created_on, channel, utm_term, utm_content)
      values (${tenantId}, 'L1', now(), current_date, 'meta', 'adset-1', '111'),
             (${tenantId}, 'L2', now(), current_date, 'meta', 'adset-1', '222'),
             (${tenantId}, 'L3', now(), current_date, 'google_ads', 'business loans', '999')`;
    await tx`insert into platform_ads (tenant_id, platform, external_id, name) values (${tenantId}, 'meta', '222', 'Known')`;
  });
});

afterAll(async () => {
  await asMaintenance((tx) => tx`delete from tenants where id = ${tenantId}`);
  await Promise.all([ownerSql.end(), jobsSql.end()]);
});

describe('resolveMetaAdNames', () => {
  it('does nothing without the config row', async () => {
    const fetchAdNames = vi.fn(async () => []);
    expect(await resolveMetaAdNames(contextWith(fetchAdNames), run)).toBe(0);
    expect(fetchAdNames).not.toHaveBeenCalled();
  });

  it('asks only about unnamed ids on Meta leads, in the configured parameter, and stores the answer', async () => {
    await asMaintenance(
      (tx) => tx`
        insert into tenant_config (tenant_id, key, value)
        values (${tenantId}, 'landing_url_parameters', ${tx.json({ meta: { ad: 'utm_content' } })})`,
    );
    const fetchAdNames = vi.fn(async (_c: Connection, ids: readonly string[]) =>
      ids.includes('111') ? [{ id: '111', name: 'SCG Submit' }] : [],
    );
    expect(await resolveMetaAdNames(contextWith(fetchAdNames), run)).toBe(1);
    expect(fetchAdNames.mock.calls[0]![1]).toEqual(['111']);

    const rows = await run((tx) => tx.select().from(schema.platformAds));
    expect(rows.map((r) => [r.externalId, r.name]).sort()).toEqual([
      ['111', 'SCG Submit'],
      ['222', 'Known'],
    ]);
  });
});
