/**
 * The click_view backfill, run on demand.
 *
 *   pnpm --filter @zeeraa/jobs backfill-clicks <tenant-slug> [--days 90] [--max-days N]
 *
 * Separate from the nightly sync because it is the one pass with a deadline on
 * it. `click_view` serves the trailing ninety days and nothing older: a day not
 * captured before it ages out is not a retryable failure, it is a permanent
 * hole in the attribution record. Campaigns and daily spend can be pulled again
 * next week; these cannot.
 *
 * Campaigns are refreshed first, in one request. `ad_clicks.campaign_id`
 * resolves against whatever campaigns are known at write time, so running the
 * backfill against an empty `campaigns` table would write ninety days of clicks
 * that resolve to nothing and need the whole window pulled again to repair.
 */
import { and, eq } from 'drizzle-orm';
import { getOwnerDb, schema, withJobTenant, withMaintenance, type Database } from '@zeeraa/db';
import { earliestClickDay } from '@zeeraa/connectors';
import { tenantDay, trailingWindow } from '@zeeraa/core';
import { resolveGoogleAdsContext } from '../src/google-ads/context';
import { clickCoverage, ingestClicks } from '../src/google-ads/clicks';
import { upsertCampaigns } from '../src/google-ads/writer';
import { closeSyncRun, openSyncRun } from '../src/sync-runs';

const args = process.argv.slice(2);
const slug = args[0];
if (!slug) throw new Error('Usage: tsx scripts/backfill-clicks.ts <tenant-slug> [--days N] [--max-days N]');

const flag = (name: string): number | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : Number(args[i + 1]);
};
const windowDays = flag('days') ?? 90;
const maxDays = flag('max-days');

const { db, close } = getOwnerDb();

try {
  const { tenantId, connectionId, timezone } = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx
      .select({ id: schema.tenants.id, name: schema.tenants.name, timezone: schema.tenants.timezone })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

    // Maintenance crosses tenants by design, so the tenant predicate here is
    // doing real work rather than decorating a policy that would enforce it.
    const [googleAds] = await tx
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.tenantId, tenant.id),
          eq(schema.connections.platform, 'google_ads'),
        ),
      );
    if (!googleAds) throw new Error(`${tenant.name} has no google_ads connection.`);

    console.log(`${tenant.name} — google_ads click backfill`);
    return { tenantId: tenant.id, connectionId: googleAds.id, timezone: tenant.timezone };
  });

  const context = await resolveGoogleAdsContext(tenantId, connectionId);
  const now = new Date();
  const today = tenantDay(now, timezone);
  const range = trailingWindow(today, windowDays);
  const earliest = earliestClickDay(today);

  console.log(`  today (${timezone}):          ${today}`);
  console.log(`  requested window:            ${range.start} → ${range.end} (${windowDays} days)`);
  console.log(`  earliest day click_view serves: ${earliest}`);
  if (maxDays) console.log(`  budget this run:             ${maxDays} days`);

  const runInTenant = <T,>(fn: (tx: Database) => Promise<T>) => withJobTenant(tenantId, fn);

  const syncRunId = await runInTenant((tx) =>
    openSyncRun(tx, tenantId, 'click-backfill', now, 'google_ads'),
  );

  const campaigns = (await context.connector.fetchEntities?.(context.connection)) ?? [];
  await runInTenant((tx) => upsertCampaigns(tx, tenantId, 'google_ads', campaigns));
  console.log(`\n  campaigns refreshed first:   ${campaigns.length}`);

  const started = Date.now();
  const result = await ingestClicks(
    runInTenant,
    {
      tenantId,
      platform: 'google_ads',
      connection: context.connection,
      connector: context.connector,
      syncRunId,
      today,
      maxDays,
    },
    range,
  );
  const elapsed = Math.round((Date.now() - started) / 1000);

  const coverage = await runInTenant((tx) => clickCoverage(tx, tenantId, 'google_ads'));

  const status =
    result.daysFailed > 0 || result.daysRemaining > 0 ? ('partial' as const) : ('succeeded' as const);
  await runInTenant((tx) =>
    closeSyncRun(tx, syncRunId, status, result.clicksWritten, result.firstError ?? null),
  );

  console.log(`\n  ── this run (${elapsed}s) ──`);
  console.log(`  days attempted:              ${result.daysAttempted}`);
  console.log(`  days succeeded:              ${result.daysSucceeded}`);
  console.log(`  days failed:                 ${result.daysFailed}`);
  console.log(`  days expired (unrecoverable): ${result.daysExpired}`);
  console.log(`  days outstanding:            ${result.daysRemaining}`);
  console.log(`  clicks written:              ${result.clicksWritten}`);
  if (result.firstError) console.log(`  first error:                 ${result.firstError}`);

  console.log(`\n  ── ledger, whole window ──`);
  console.log(`  succeeded: ${coverage.succeeded}  pending: ${coverage.pending}  failed: ${coverage.failed}  expired: ${coverage.expired}`);
  console.log(`  earliest date still reachable: ${earliest}`);
  console.log(`  sync run: ${syncRunId} (${status})`);

  if (result.daysFailed > 0) process.exitCode = 1;
} finally {
  await close();
  const { closeConnections } = await import('@zeeraa/db');
  await closeConnections();
}
