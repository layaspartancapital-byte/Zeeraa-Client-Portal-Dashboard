/**
 * LinkedIn Ads for a trailing window, run by hand — the first backfill after
 * Connect, or a re-read.
 *
 *   pnpm --filter @zeeraa/jobs sync-linkedin <tenant-slug> [--days 90]
 *
 * The same `runLinkedInSync` the hourly and nightly runs use; every write is
 * an upsert, so running it twice changes nothing.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getOwnerDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { resolveLinkedInContext } from '../src/linkedin/context';
import { runLinkedInSync } from '../src/linkedin/sync';

const args = process.argv.slice(2);
const slug = args[0];
if (!slug) throw new Error('Usage: tsx scripts/sync-linkedin.ts <tenant-slug> [--days N]');
const daysIndex = args.indexOf('--days');
const windowDays = daysIndex === -1 ? 90 : Number(args[daysIndex + 1]);
const { db, close } = getOwnerDb();

try {
  const { tenantId, connectionId } = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx.select().from(schema.tenants).where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);
    const [connection] = await tx
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(and(eq(schema.connections.tenantId, tenant.id), eq(schema.connections.platform, 'linkedin_ads')));
    if (!connection) throw new Error(`${tenant.name} has no linkedin_ads connection. Run configure-linkedin.`);
    return { tenantId: tenant.id, connectionId: connection.id };
  });

  const context = await resolveLinkedInContext(tenantId, connectionId);
  const result = await runLinkedInSync(context, { trigger: 'manual', windowDays });
  console.log(`  ${result.status}: ${result.campaigns} campaigns, ${result.dailyMetrics} metric rows`);
  if (result.accountWarning) console.log(`  note: ${result.accountWarning}`);
  const [totals] = await withJobTenant(tenantId, (tx) =>
    tx.execute<{ days: number; spend: string; impressions: string; clicks: string; conversions: string }>(sql`
      select count(distinct date)::int days, coalesce(sum(spend),0)::text spend,
             coalesce(sum(impressions),0)::text impressions, coalesce(sum(clicks),0)::text clicks,
             coalesce(sum(platform_conversions),0)::text conversions
      from daily_metrics where tenant_id = ${tenantId}::uuid and platform = 'linkedin_ads'`),
  );
  console.log('  stored:', JSON.stringify(totals));
} finally {
  const { closeConnections } = await import('@zeeraa/db');
  await Promise.race([Promise.all([close(), closeConnections()]), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(process.exitCode ?? 0);
}
