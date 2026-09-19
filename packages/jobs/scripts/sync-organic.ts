/**
 * GA4 and Search Console for a trailing window.
 *
 *   pnpm --filter @zeeraa/jobs sync-organic <tenant-slug> [--days 90] [--only ga4|search_console]
 *
 * Both re-pull the whole window and upsert rather than appending from a
 * watermark: GA4 reprocesses for about 48 hours and Search Console finalises
 * over two to three days, so an append would double-count every restatement.
 *
 * Neither writes attribution. Neither can: the GA4 Data API exposes no
 * identifier for a person or a session, and Search Console reports queries and
 * pages and never users.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getOwnerDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { resolveOrganicContext, type OrganicPlatform } from '../src/google-organic/context';
import { runGa4Sync, runSearchConsoleSync } from '../src/google-organic/sync';

const args = process.argv.slice(2);
const slug = args[0];
if (!slug) throw new Error('Usage: tsx scripts/sync-organic.ts <tenant-slug> [--days N] [--only p]');
const daysIndex = args.indexOf('--days');
const windowDays = daysIndex === -1 ? 90 : Number(args[daysIndex + 1]);
const onlyIndex = args.indexOf('--only');
const only = onlyIndex === -1 ? null : (args[onlyIndex + 1] as OrganicPlatform);

const PLATFORMS: OrganicPlatform[] = ['ga4', 'search_console'];
const { db, close } = getOwnerDb();

try {
  const { tenantId, connections } = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx
      .select({ id: schema.tenants.id, name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

    const rows = await tx
      .select({ id: schema.connections.id, platform: schema.connections.platform })
      .from(schema.connections)
      .where(eq(schema.connections.tenantId, tenant.id));

    console.log(`${tenant.name} — organic sources`);
    return { tenantId: tenant.id, connections: rows };
  });

  for (const platform of PLATFORMS) {
    if (only && only !== platform) continue;
    const connection = connections.find((c) => c.platform === platform);
    if (!connection) {
      console.log(`\n  ${platform}: no connection row. Seed it first.`);
      continue;
    }

    console.log(`\n── ${platform} ──`);
    const context = await resolveOrganicContext(tenantId, connection.id, platform);
    const result =
      platform === 'ga4'
        ? await runGa4Sync(context, { trigger: 'manual', windowDays })
        : await runSearchConsoleSync(context, { trigger: 'manual', windowDays });

    console.log(`  window:          ${result.range.start} → ${result.range.end}`);
    console.log(`  daily totals:    ${result.totals}`);
    console.log(`  breakdown rows:  ${result.breakdownA + result.breakdownB}`);
    console.log(`  status:          ${result.status}${result.note ? ` — ${result.note}` : ''}`);

    // Read back from the table, so the figure printed is the one that will be
    // rendered rather than the one that was fetched.
    const table = platform === 'ga4' ? sql`ga4_metrics` : sql`search_console_metrics`;
    const metric = platform === 'ga4' ? sql`sessions` : sql`clicks`;
    const [totals] = await withJobTenant(tenantId, (tx) =>
      tx.execute<{ days: number; rows: number; value: string }>(sql`
        select count(distinct date)::int as days,
               count(*)::int as rows,
               coalesce(sum(${metric}) filter (where dimension = 'total'), 0)::text as value
        from ${table} where tenant_id = ${tenantId}::uuid`),
    );
    console.log(`  in table:        ${totals!.rows} rows across ${totals!.days} days`);
    console.log(`  ${platform === 'ga4' ? 'sessions' : 'clicks'} (totals row): ${totals!.value}`);
  }
} finally {
  await close();
  const { closeConnections } = await import('@zeeraa/db');
  await closeConnections();
}
