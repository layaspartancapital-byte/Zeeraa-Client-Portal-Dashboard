/**
 * `platform_ads` (0041) is tenant data like any other: a member reads their
 * own tenant's ad names, a client cannot write them, and the ingestion role in
 * one tenant cannot reach another's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/schema';
import { withJobTenant, withTenant } from '../src/tenant-context';
import type { Database } from '../src/client';
import { appClient, asOwner, cleanup, failure, ownerClient, seedTwoTenants, type Fixture } from './fixtures';

const JOBS_URL =
  process.env.DATABASE_URL_JOBS ??
  'postgres://zeeraa_jobs_runner:zeeraa_jobs_runner@localhost:5433/zeeraa';

const owner = ownerClient();
const app = appClient();
const jobsSql = postgres(JOBS_URL, { max: 2, prepare: false, onnotice: () => {} });
const jobs = drizzle(jobsSql, { schema }) as unknown as Database;
let fx: Fixture;

beforeAll(async () => {
  fx = await seedTwoTenants(owner.db);
  await asOwner(owner.db, (tx) =>
    tx.insert(schema.platformAds).values([
      { tenantId: fx.tenantA, platform: 'meta', externalId: '111', name: 'A ad' },
      { tenantId: fx.tenantB, platform: 'meta', externalId: '222', name: 'B ad' },
    ]),
  );
});

afterAll(async () => {
  await cleanup(owner.db, fx);
  await Promise.all([owner.client.end(), app.client.end(), jobsSql.end()]);
});

describe('platform_ads', () => {
  it('shows a member only their own tenant', async () => {
    const rows = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) => tx.select().from(schema.platformAds),
      app.db,
    );
    expect(rows.map((r) => r.name)).toEqual(['A ad']);
  });

  it('refuses a client writing one', async () => {
    const denied = await failure(() =>
      withTenant(
        { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
        (tx) => tx.insert(schema.platformAds).values({ tenantId: fx.tenantA, platform: 'meta', externalId: '333', name: 'x' }),
        app.db,
      ),
    );
    expect(denied.code).toBe('42501');
  });

  it('keeps the ingestion role inside its tenant', async () => {
    const seen = await withJobTenant(fx.tenantA, (tx) => tx.select().from(schema.platformAds), jobs);
    expect(seen.map((r) => r.name)).toEqual(['A ad']);
    const denied = await failure(() =>
      withJobTenant(
        fx.tenantA,
        (tx) => tx.insert(schema.platformAds).values({ tenantId: fx.tenantB, platform: 'meta', externalId: '444', name: 'x' }),
        jobs,
      ),
    );
    expect(denied.code).toBe('42501');
  });
});
