/**
 * GA4 and Search Console rows are tenant data like everything else.
 *
 * Less obviously sensitive than a merchant's phone number, and no less
 * confidential: a competitor's landing pages, the queries they rank for and
 * what those queries are worth is a commercial map of their acquisition. Two
 * lenders in adjacent tabs is the scenario this whole model exists for.
 *
 * Scoped to the fixture's own tenants throughout: packages test concurrently
 * against one Postgres, so an assertion about "every row" would be an assertion
 * about another suite's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../src/schema';
import { withJobTenant, withTenant } from '../src/tenant-context';
import { appClient, asOwner, cleanup, failure, ownerClient, seedTwoTenants, type Fixture } from './fixtures';

const owner = ownerClient();
const app = appClient();
let fx: Fixture;

beforeAll(async () => {
  fx = await seedTwoTenants(owner.db);
  await asOwner(owner.db, async (tx) => {
    await tx.insert(schema.ga4Metrics).values([
      { tenantId: fx.tenantA, date: '2026-09-01', dimension: 'total', dimensionValue: '', sessions: '900' },
      { tenantId: fx.tenantB, date: '2026-09-01', dimension: 'total', dimensionValue: '', sessions: '7777' },
      { tenantId: fx.tenantB, date: '2026-09-01', dimension: 'landing_page', dimensionValue: '/b-secret-offer', sessions: '404' },
    ]);
    await tx.insert(schema.searchConsoleMetrics).values([
      { tenantId: fx.tenantA, date: '2026-09-01', dimension: 'total', dimensionValue: '', clicks: '50' },
      { tenantId: fx.tenantB, date: '2026-09-01', dimension: 'query', dimensionValue: 'b competitor keyword', clicks: '33', impressions: '900', position: '2.5000' },
    ]);
  });
});

afterAll(async () => {
  await cleanup(owner.db, fx);
  await Promise.all([owner.client.end(), app.client.end()]);
});

describe('ga4_metrics', () => {
  it('shows a client its own rows and none of anybody else’s', async () => {
    const rows = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) => tx.select().from(schema.ga4Metrics),
      app.db,
    );
    // Both halves, and the first one is load-bearing: dropping the policy
    // returns *nothing*, and `every()` over an empty array is vacuously true.
    // A test that only asserts the absence of other tenants' rows passes
    // whether or not the control exists, which is exactly the shape the
    // mutation suite is there to catch — and did.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === fx.tenantA)).toBe(true);
    expect(rows.some((r) => r.dimensionValue === '/b-secret-offer')).toBe(false);
  });

  it('refuses a row written into a tenant the context does not name', async () => {
    const error = await failure(() =>
      withTenant(
        { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
        (tx) =>
          tx.insert(schema.ga4Metrics).values({
            tenantId: fx.tenantB,
            date: '2026-09-02',
            dimension: 'total',
            dimensionValue: '',
            sessions: '1',
          }),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');
  });

  it('reads nothing at all with no tenant context', async () => {
    expect(await app.db.select().from(schema.ga4Metrics)).toHaveLength(0);
  });
});

describe('search_console_metrics', () => {
  it('shows a client its own rows and none of anybody else’s', async () => {
    const rows = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) => tx.select().from(schema.searchConsoleMetrics),
      app.db,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === fx.tenantA)).toBe(true);
    expect(rows.some((r) => r.dimensionValue.includes('competitor'))).toBe(false);
  });

  it('reads nothing at all with no tenant context', async () => {
    expect(await app.db.select().from(schema.searchConsoleMetrics)).toHaveLength(0);
  });
});

describe('the ingestion role', () => {
  it('writes inside the tenant it was given and reads no other, on ga4_metrics', async () => {
    const written = await withJobTenant(fx.tenantA, (tx) =>
      tx
        .insert(schema.ga4Metrics)
        .values({
          tenantId: fx.tenantA,
          date: '2026-09-03',
          dimension: 'source_medium',
          dimensionValue: 'google / organic',
          sessions: '12',
        })
        .returning(),
    );
    expect(written).toHaveLength(1);

    const seen = await withJobTenant(fx.tenantA, (tx) => tx.select().from(schema.ga4Metrics));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.tenantId === fx.tenantA)).toBe(true);
  });

  it('reads no other tenant on search_console_metrics either', async () => {
    // Its own test rather than a loop: the two tables carry two policies, and
    // a mutation that opened one and not the other went unnoticed until this
    // existed.
    const seen = await withJobTenant(fx.tenantA, (tx) =>
      tx.select().from(schema.searchConsoleMetrics),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.tenantId === fx.tenantA)).toBe(true);
    expect(seen.some((r) => r.dimensionValue.includes('competitor'))).toBe(false);
  });

  it('sees nothing on either table with no tenant set', async () => {
    const { getJobsDb } = await import('../src/client');
    const jobs = getJobsDb();
    expect(await jobs.select().from(schema.ga4Metrics)).toHaveLength(0);
    expect(await jobs.select().from(schema.searchConsoleMetrics)).toHaveLength(0);
  });
});

describe('the upsert key', () => {
  it('refuses a second row for the same day, dimension and value', async () => {
    // Both APIs restate, so the nightly re-pull has to converge on one row.
    const error = await failure(() =>
      asOwner(owner.db, (tx) =>
        tx.insert(schema.searchConsoleMetrics).values({
          tenantId: fx.tenantA,
          date: '2026-09-01',
          dimension: 'total',
          dimensionValue: '',
          clicks: '999',
        }),
      ),
    );
    expect(error.code).toBe('23505');
  });
});
