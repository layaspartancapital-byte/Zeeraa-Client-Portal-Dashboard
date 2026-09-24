/**
 * The configuration changes of the 24 September 2026 client fixes, for one
 * tenant, in one transaction:
 *
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/apply-client-fixes.ts --dry-run
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/apply-client-fixes.ts
 *
 *   1. `revenueBandEdges` on the Salesforce connection's lead mapping, so the
 *      sync stores each lead's merged revenue band (migration 0034 first).
 *   2. The `lender_exclusions` config row, and its effect on the submissions
 *      already stored, so the test lenders leave the totals now rather than
 *      at the next sync.
 *   3. The four `blocked_dependencies` rows the Data quality card replaced
 *      with measured figures or dropped, and the retired deal-level
 *      `offer_rate` metric one of them existed to hide.
 *
 * Targeted rather than `db:seed`, which would rewrite every config row.
 * `--dry-run` writes, reads every change back and rolls back: under FORCE a
 * denied write matches nothing and exits 0, so the read-back is the proof.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getOwnerDb } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';
import { spartan } from '../seeds/spartan';

const DRY_RUN = process.argv.includes('--dry-run');
const slug = process.env.TENANT_SLUG ?? spartan.tenant.slug;
const RETIRED_BLOCKS = [
  'mql_revenue_coverage',
  'offer_rate_definition',
  'revenue_band_breakdown',
  'decline_reason_deal_grain',
];
const RETIRED_METRIC = 'offer_rate';

const salesforceSeed = spartan.connections.find((c) => c.platform === 'salesforce');
const edges = (salesforceSeed?.config as { fieldMapping?: { lead?: { revenueBandEdges?: number[] } } } | undefined)
  ?.fieldMapping?.lead?.revenueBandEdges;
const lenderRow = spartan.config.find((c) => c.key === 'lender_exclusions');
if (!edges || !lenderRow) throw new Error('The seed carries no revenueBandEdges or lender_exclusions.');
const lenderIds = (lenderRow.value as { lenders: { id: string }[] }).lenders.map((l) => l.id);
const lenderReason = (lenderRow.value as { reason: string }).reason;

class Rollback extends Error {}

const { db, close } = getOwnerDb();
try {
  const report = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

    const [column] = await tx.execute<{ n: number }>(
      sql`select count(*)::int n from information_schema.columns where table_name = 'leads' and column_name = 'revenue_band'`,
    );
    if (!column || Number(column.n) === 0) throw new Error('Migration 0034 has not been applied: leads.revenue_band is missing.');

    // 1. Band edges on the connection's lead mapping.
    const connWhere = and(eq(schema.connections.tenantId, tenant.id), eq(schema.connections.platform, 'salesforce'));
    const [conn] = await tx.select({ config: schema.connections.config }).from(schema.connections).where(connWhere);
    if (!conn) throw new Error('No Salesforce connection.');
    const config = structuredClone(conn.config ?? {}) as { fieldMapping?: { lead?: Record<string, unknown> } };
    if (!config.fieldMapping?.lead) throw new Error('The Salesforce connection has no lead mapping.');
    config.fieldMapping.lead.revenueBandEdges = edges;
    await tx.update(schema.connections).set({ config }).where(connWhere);
    const [connAfter] = await tx.select({ config: schema.connections.config }).from(schema.connections).where(connWhere);
    const stored = (connAfter?.config as typeof config).fieldMapping?.lead?.revenueBandEdges;
    if (JSON.stringify(stored) !== JSON.stringify(edges)) throw new Error('revenueBandEdges did not read back — denied.');

    // 2. The lender exclusion, and the submissions it already covers.
    await tx
      .insert(schema.tenantConfig)
      .values({ tenantId: tenant.id, key: lenderRow.key, value: lenderRow.value, description: lenderRow.description ?? null })
      .onConflictDoUpdate({
        target: [schema.tenantConfig.tenantId, schema.tenantConfig.key],
        set: { value: lenderRow.value, description: lenderRow.description ?? null, updatedAt: new Date() },
      });
    const [cfg] = await tx
      .select({ key: schema.tenantConfig.key })
      .from(schema.tenantConfig)
      .where(and(eq(schema.tenantConfig.tenantId, tenant.id), eq(schema.tenantConfig.key, lenderRow.key)));
    if (!cfg) throw new Error('lender_exclusions did not read back — denied.');
    const lenderSubs = and(
      eq(schema.submissions.tenantId, tenant.id),
      inArray(schema.submissions.lenderExternalId, lenderIds),
    );
    const excluded = await tx
      .update(schema.submissions)
      .set({ excludedReason: lenderReason })
      .where(and(lenderSubs, sql`${schema.submissions.excludedReason} is null`))
      .returning({ id: schema.submissions.id });
    const [still] = await tx.execute<{ n: number }>(
      sql`select count(*)::int n from submissions where tenant_id = ${tenant.id}
          and lender_external_id in ${lenderIds} and excluded_reason is null`,
    );
    if (Number(still!.n) !== 0) throw new Error('Test-lender submissions are still counted — denied.');

    // 3. The retired dependencies and metric.
    const blocks = and(
      eq(schema.blockedDependencies.tenantId, tenant.id),
      inArray(schema.blockedDependencies.key, RETIRED_BLOCKS),
    );
    const deletedBlocks = await tx.delete(schema.blockedDependencies).where(blocks).returning({ key: schema.blockedDependencies.key });
    const leftBlocks = await tx.select({ key: schema.blockedDependencies.key }).from(schema.blockedDependencies).where(blocks);
    if (leftBlocks.length > 0) throw new Error('Blocked rows did not delete — denied.');
    const metricWhere = and(eq(schema.tenantMetrics.tenantId, tenant.id), eq(schema.tenantMetrics.key, RETIRED_METRIC));
    const deletedMetric = await tx.delete(schema.tenantMetrics).where(metricWhere).returning({ key: schema.tenantMetrics.key });
    const leftMetric = await tx.select({ key: schema.tenantMetrics.key }).from(schema.tenantMetrics).where(metricWhere);
    if (leftMetric.length > 0) throw new Error('offer_rate did not delete — denied.');

    const result = {
      revenueBandEdges: edges.join(', '),
      lenderSubmissionsExcluded: excluded.length,
      blockedRowsDeleted: deletedBlocks.map((b) => b.key).join(', ') || '(none present)',
      metricDeleted: deletedMetric.map((m) => m.key).join(', ') || '(none present)',
    };
    if (DRY_RUN) {
      console.log('Would apply:', result);
      throw new Rollback();
    }
    return result;
  }).catch((e) => {
    if (e instanceof Rollback) return null;
    throw e;
  });
  if (report === null) console.log(`Dry run against ${slug}: every change landed and read back, then rolled back.`);
  else console.log(`Applied to ${slug}:`, report);
} finally {
  await close();
}
