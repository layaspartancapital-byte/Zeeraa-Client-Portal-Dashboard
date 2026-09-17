/**
 * Campaigns and daily spend for a trailing window.
 *
 *   pnpm --filter @zeeraa/jobs sync-google-ads <tenant-slug> [--days 90] [--skip-clicks]
 *
 * The whole window in one request, per §6: Google restates conversions for
 * thirty days and more, so every run re-pulls and upserts rather than appending
 * from a watermark. An append would double-count every restatement.
 *
 * `--skip-clicks` runs the campaign and spend passes alone, for when the click
 * ledger has already been brought up to date by `backfill-clicks` and there is
 * no reason to spend the quota twice in one evening.
 */
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { getOwnerDb, schema, withJobTenant, withMaintenance, type Database } from '@zeeraa/db';
import { tenantDay, trailingWindow } from '@zeeraa/core';
import { resolveGoogleAdsContext } from '../src/google-ads/context';
import { upsertCampaigns, upsertDailyMetrics } from '../src/google-ads/writer';
import { closeSyncRun, openSyncRun } from '../src/sync-runs';

const args = process.argv.slice(2);
const slug = args[0];
if (!slug) throw new Error('Usage: tsx scripts/sync-google-ads.ts <tenant-slug> [--days N]');

const daysIndex = args.indexOf('--days');
const windowDays = daysIndex === -1 ? 90 : Number(args[daysIndex + 1]);

const { db, close } = getOwnerDb();

try {
  const { tenantId, connectionId, timezone, currency } = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx
      .select({
        id: schema.tenants.id,
        name: schema.tenants.name,
        timezone: schema.tenants.timezone,
        currency: schema.tenants.currency,
      })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

    const [connection] = await tx
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.tenantId, tenant.id),
          eq(schema.connections.platform, 'google_ads'),
        ),
      );
    if (!connection) throw new Error(`${tenant.name} has no google_ads connection.`);

    console.log(`${tenant.name} — google_ads campaigns and daily spend`);
    return {
      tenantId: tenant.id,
      connectionId: connection.id,
      timezone: tenant.timezone,
      currency: tenant.currency,
    };
  });

  const context = await resolveGoogleAdsContext(tenantId, connectionId);
  const now = new Date();
  const today = tenantDay(now, timezone);
  const range = trailingWindow(today, windowDays);
  console.log(`  window: ${range.start} → ${range.end} (${windowDays} days)`);

  const runInTenant = <T,>(fn: (tx: Database) => Promise<T>) => withJobTenant(tenantId, fn);
  const syncRunId = await runInTenant((tx) =>
    openSyncRun(tx, tenantId, 'manual-spend-pull', now, 'google_ads'),
  );

  try {
    const campaigns = (await context.connector.fetchEntities?.(context.connection)) ?? [];
    const campaignIds = await runInTenant((tx) =>
      upsertCampaigns(tx, tenantId, 'google_ads', campaigns),
    );

    const metrics = await context.connector.fetchDailyMetrics(context.connection, range);
    const written = await runInTenant((tx) =>
      upsertDailyMetrics(tx, tenantId, 'google_ads', metrics, campaignIds, syncRunId),
    );

    // Read back from the table rather than summing what was just fetched: the
    // figure to sanity-check against Google's UI is the one that will be
    // rendered, and anything the upsert dropped or coalesced belongs in it.
    const [totals] = await runInTenant((tx) =>
      tx
        .select({
          spend: sql<string>`coalesce(sum(${schema.dailyMetrics.spend}), 0)`,
          impressions: sql<string>`coalesce(sum(${schema.dailyMetrics.impressions}), 0)`,
          clicks: sql<string>`coalesce(sum(${schema.dailyMetrics.clicks}), 0)`,
          conversions: sql<string>`coalesce(sum(${schema.dailyMetrics.platformConversions}), 0)`,
          rows: sql<number>`count(*)::int`,
          days: sql<number>`count(distinct ${schema.dailyMetrics.date})::int`,
          accountLevel: sql<number>`count(*) filter (where ${schema.dailyMetrics.campaignId} is null)::int`,
        })
        .from(schema.dailyMetrics)
        .where(
          and(
            eq(schema.dailyMetrics.tenantId, tenantId),
            eq(schema.dailyMetrics.platform, 'google_ads'),
            gte(schema.dailyMetrics.date, range.start),
            lte(schema.dailyMetrics.date, range.end),
          ),
        ),
    );

    const spending = await runInTenant((tx) =>
      tx
        .select({ campaignId: schema.dailyMetrics.campaignId })
        .from(schema.dailyMetrics)
        .where(
          and(
            eq(schema.dailyMetrics.tenantId, tenantId),
            eq(schema.dailyMetrics.platform, 'google_ads'),
            gte(schema.dailyMetrics.date, range.start),
            lte(schema.dailyMetrics.date, range.end),
          ),
        )
        .groupBy(schema.dailyMetrics.campaignId),
    );

    await runInTenant((tx) =>
      closeSyncRun(tx, syncRunId, 'succeeded', campaigns.length + written, null),
    );

    console.log(`\n  campaigns in account:        ${campaigns.length}`);
    console.log(`  campaigns with spend rows:   ${spending.filter((r) => r.campaignId).length}`);
    console.log(`  daily_metrics rows upserted: ${written}`);
    console.log(`  rows in window:              ${totals!.rows} across ${totals!.days} days`);
    console.log(`  account-level rows (no campaign): ${totals!.accountLevel}`);
    console.log(`\n  total spend:        ${currency} ${Number(totals!.spend).toFixed(2)}`);
    console.log(`  total impressions:  ${Number(totals!.impressions).toLocaleString('en-US')}`);
    console.log(`  total clicks:       ${Number(totals!.clicks).toLocaleString('en-US')}`);
    console.log(`  platform conversions: ${Number(totals!.conversions).toFixed(2)}`);
    console.log(`\n  sync run: ${syncRunId}`);
  } catch (error) {
    await runInTenant((tx) => closeSyncRun(tx, syncRunId, 'failed', 0, String(error)));
    throw error;
  }
} finally {
  await close();
  const { closeConnections } = await import('@zeeraa/db');
  await closeConnections();
}
