/**
 * Semrush rows are tenant data (migration 0042).
 *
 * A lender's keywords, the competitors Semrush names for it and the sites that
 * link to it are its acquisition map, and Zeeraa staff sit with two competing
 * lenders open in adjacent tabs. Every one of the ten tables is checked on
 * its own — they carry ten sets of policies, and a mutation that opens one
 * table and not the others must fail a test.
 *
 * Scoped to the fixture's own tenants: packages test concurrently against one
 * Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../src/schema';
import { withJobTenant, withTenant } from '../src/tenant-context';
import { appClient, asOwner, cleanup, failure, ownerClient, seedTwoTenants, type Fixture } from './fixtures';

const owner = ownerClient();
const app = appClient();
let fx: Fixture;

const month = '2026-09-01';
const day = '2026-09-27';

function rowsFor(tenantId: string, secret: string) {
  return {
    seo_report_reads: [schema.seoReportReads, { tenantId, report: `domain_overview_${secret}`, readOn: day, units: 10, rows: 1 }],
    seo_domain_months: [
      schema.seoDomainMonths,
      {
        tenantId, database: 'us', month, readOn: day, organicKeywords: secret === 'b' ? 7777 : 100,
        positions1to3: 1, positions4to10: 2, positions11to20: 3, organicTraffic: 4, organicTrafficCost: '5.00',
        aiOverviewKeywords: 6, aiOverviewCited: 7,
      },
    ],
    seo_backlink_months: [
      schema.seoBacklinkMonths,
      { tenantId, month, readOn: day, authorityScore: 18, backlinks: 1, referringDomains: secret === 'b' ? 7777 : 10 },
    ],
    seo_keywords: [
      schema.seoKeywords,
      { tenantId, database: 'us', month, list: 'top_organic', keyword: `${secret} secret keyword`, position: 1, searchVolume: 10, url: 'https://x/', readOn: day },
    ],
    seo_competitors: [
      schema.seoCompetitors,
      {
        tenantId, database: 'us', month, domain: `${secret}-rival.example`, relevance: '0.5', commonKeywords: 1,
        organicKeywords: 1, organicTraffic: 1, organicTrafficCost: '1.00', readOn: day,
      },
    ],
    seo_referring_domain_changes: [
      schema.seoReferringDomainChanges,
      { tenantId, change: 'new', domain: `${secret}-linker.example`, authorityScore: 1, backlinks: 1, firstSeen: day, lastSeen: day, readOn: day },
    ],
    seo_site_audits: [
      schema.seoSiteAudits,
      {
        tenantId, projectId: 1, snapshotId: `snap-${secret}`, finishedAt: new Date(`${day}T12:00:00Z`), finishedOn: day,
        healthScore: 93, pagesCrawled: 1, pagesLimit: 1, errors: 0, warnings: 0, notices: 0, readOn: day,
      },
    ],
    seo_site_audit_issues: [
      schema.seoSiteAuditIssues,
      { tenantId, snapshotId: `snap-${secret}`, issueId: 2, severity: 'error', title: `${secret} issue`, count: 1, delta: 0 },
    ],
    seo_tracked_positions: [
      schema.seoTrackedPositions,
      { tenantId, campaignId: '1_1', day, keyword: `${secret} tracked`, position: 3 },
    ],
    seo_tracking_visibility: [schema.seoTrackingVisibility, { tenantId, campaignId: '1_1', day, visibility: '12.500' }],
  } as unknown as Record<string, [PgTable, Record<string, unknown>]>;
}

const TABLES = Object.keys(rowsFor('x', 'x'));

beforeAll(async () => {
  fx = await seedTwoTenants(owner.db);
  await asOwner(owner.db, async (tx) => {
    // Audits first: the issues reference them.
    const order = [...TABLES.filter((t) => t !== 'seo_site_audit_issues'), 'seo_site_audit_issues'];
    for (const [tenantId, secret] of [[fx.tenantA, 'a'], [fx.tenantB, 'b']] as const) {
      const rows = rowsFor(tenantId, secret);
      for (const name of order) {
        const [table, row] = rows[name]!;
        await tx.insert(table).values(row as never);
      }
    }
  });
});

afterAll(async () => {
  await cleanup(owner.db, fx);
  await Promise.all([owner.client.end(), app.client.end()]);
});

describe.each(TABLES)('%s', (name) => {
  const table = () => rowsFor('x', 'x')[name]![0];

  it('shows a client its own rows and none of the other tenant’s', async () => {
    const rows = (await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) => tx.select().from(table()),
      app.db,
    )) as { tenantId: string }[];
    // Non-empty first: a dropped policy returns nothing, and `every` over
    // nothing is vacuously true.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === fx.tenantA)).toBe(true);
  });

  it('refuses a client write, even into its own tenant', async () => {
    const error = await failure(() =>
      withTenant(
        { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
        (tx) => tx.insert(table()).values(rowsFor(fx.tenantA, `w${name}`)[name]![1] as never),
        app.db,
      ),
    );
    expect(error.code).toBe('42501');
  });

  it('reads nothing with no tenant context', async () => {
    expect(await app.db.select().from(table())).toHaveLength(0);
  });

  it('lets the ingestion role read its tenant and no other', async () => {
    const seen = (await withJobTenant(fx.tenantA, (tx) => tx.select().from(table()))) as { tenantId: string }[];
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.tenantId === fx.tenantA)).toBe(true);
  });

  it('refuses the ingestion role a row for another tenant', async () => {
    const error = await failure(() =>
      withJobTenant(fx.tenantA, (tx) => tx.insert(table()).values(rowsFor(fx.tenantB, `j${name}`)[name]![1] as never)),
    );
    expect(error.code).toBe('42501');
  });
});

describe('the upsert keys', () => {
  it('refuses a second snapshot for the same tenant, database and month', async () => {
    const error = await failure(() =>
      asOwner(owner.db, (tx) => tx.insert(schema.seoDomainMonths).values(rowsFor(fx.tenantA, 'a').seo_domain_months![1] as never)),
    );
    expect(error.code).toBe('23505');
  });
});
