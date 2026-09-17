/**
 * The ingestion role.
 *
 * A sync writes on nobody's behalf, so it cannot use the user-scoped policies.
 * These tests hold the line that replaces them: scoped to one tenant, limited
 * to the tables ingestion writes, and no way out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/schema';
import { withJobTenant } from '../src/tenant-context';
import {
  asOwner,
  cleanup,
  failure,
  ownerClient,
  seedTwoTenants,
  type Fixture,
} from './fixtures';

const JOBS_URL =
  process.env.DATABASE_URL_JOBS ??
  'postgres://zeeraa_jobs_runner:zeeraa_jobs_runner@localhost:5433/zeeraa';

const owner = ownerClient();
const jobsSql = postgres(JOBS_URL, { max: 2, prepare: false, onnotice: () => {} });
const jobs = drizzle(jobsSql, { schema });
let fx: Fixture;

beforeAll(async () => {
  fx = await seedTwoTenants(owner.db);
});

afterAll(async () => {
  await cleanup(owner.db, fx);
  await Promise.all([owner.client.end(), jobsSql.end()]);
});

describe('the ingestion role', () => {
  it('cannot bypass row level security', async () => {
    const rows = await jobs.execute<{ bypass: boolean; super: boolean }>(sql`
      select rolbypassrls as bypass, rolsuper as super from pg_roles where rolname = current_user
    `);
    expect(rows[0]?.bypass).toBe(false);
    expect(rows[0]?.super).toBe(false);
  });

  it('sees nothing outside a tenant context', async () => {
    expect(await jobs.select().from(schema.opportunities)).toHaveLength(0);
  });

  it('reads and writes inside the tenant it was given', async () => {
    const written = await withJobTenant(
      fx.tenantA,
      (tx) =>
        tx
          .insert(schema.opportunities)
          .values({
            tenantId: fx.tenantA,
            externalId: 'JOB-OPP-1',
            createdAt: new Date(),
            currentStage: 'lead',
          })
          .returning(),
      jobs,
    );
    expect(written).toHaveLength(1);

    const read = await withJobTenant(
      fx.tenantA,
      (tx) => tx.select().from(schema.opportunities),
      jobs,
    );
    expect(read.map((r) => r.externalId).sort()).toEqual(['A-OPP-1', 'JOB-OPP-1']);
  });

  it('reads nothing from another tenant even with no filter', async () => {
    const rows = await withJobTenant(
      fx.tenantB,
      (tx) => tx.select().from(schema.opportunities),
      jobs,
    );
    expect(rows.map((r) => r.externalId)).toEqual(['B-OPP-1']);
  });

  it('cannot write into a tenant other than the one it is scoped to', async () => {
    const error = await failure(() =>
      withJobTenant(
        fx.tenantA,
        (tx) =>
          tx.insert(schema.opportunities).values({
            tenantId: fx.tenantB,
            externalId: 'JOB-SNEAK',
            createdAt: new Date(),
            currentStage: 'lead',
          }),
        jobs,
      ),
    );
    expect(error.code).toBe('42501');
  });

  it('cannot open the maintenance door', async () => {
    // Not a member of zeeraa_maintenance, so setting the flag does nothing at
    // all — the policy it unlocks does not apply to this role.
    const rows = await jobs.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.maintenance', 'on', true)`);
      return tx.select().from(schema.opportunities);
    });
    expect(rows).toHaveLength(0);
  });

  it('cannot reach tables ingestion has no business in', async () => {
    // A connector written in a hurry against a vendor API should not be one
    // typo away from the approval workspace or the identity tables.
    for (const table of [schema.assets, schema.notifications, schema.memberships]) {
      const error = await failure(() =>
        withJobTenant(fx.tenantA, (tx) => tx.select().from(table), jobs),
      );
      // 42501: insufficient privilege. Not an empty result — the grant is absent.
      expect(error.code).toBe('42501');
    }
  });

  it('reads configuration but cannot rewrite it', async () => {
    const stages = await withJobTenant(
      fx.tenantA,
      (tx) => tx.select().from(schema.funnelStages),
      jobs,
    );
    expect(Array.isArray(stages)).toBe(true);

    const error = await failure(() =>
      withJobTenant(
        fx.tenantA,
        (tx) =>
          tx.insert(schema.funnelStages).values({
            tenantId: fx.tenantA,
            position: 99,
            key: 'smuggled',
            label: 'Smuggled',
          }),
        jobs,
      ),
    );
    expect(error.code).toBe('42501');
  });

  it('leaves its tenant context behind when the transaction ends', async () => {
    await withJobTenant(fx.tenantA, (tx) => tx.select().from(schema.opportunities), jobs);
    const after = await jobs.execute<{ v: string }>(
      sql`select coalesce(current_setting('app.current_tenant_id', true), '') as v`,
    );
    expect(after[0]?.v).toBe('');
  });
});

describe('cleanup', () => {
  it('removes the row this suite wrote', async () => {
    await asOwner(owner.db, (tx) =>
      tx.delete(schema.opportunities).where(sql`external_id = 'JOB-OPP-1'`),
    );
    expect(true).toBe(true);
  });
});
