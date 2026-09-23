/**
 * Re-reads a range of days from one source, or runs the nightly re-pull by
 * hand.
 *
 *   pnpm --filter @zeeraa/jobs repull <tenant-slug> <platform> <start> <end>
 *   pnpm --filter @zeeraa/jobs repull <tenant-slug> --nightly
 *
 * `platform` is google_ads, meta, ga4 or search_console. Every write is the
 * connector's own upsert, so re-reading a day replaces it and nothing
 * double-counts; the days read are recorded in `sync_days` as they would be on
 * a scheduled run. Google Ads spend only — `click_view` is per day and has its
 * own ledger and `backfill-clicks`.
 *
 * Reads connections on maintenance and writes on the ingestion role, as the
 * scheduled runs do: `DATABASE_URL_MAINT`, `DATABASE_URL_JOBS` and
 * `ENCRYPTION_KEY`.
 */
import { and, eq } from 'drizzle-orm';
import { getMaintenanceDb, schema, withMaintenance } from '@zeeraa/db';
import { resolveGoogleAdsContext } from '../src/google-ads/context';
import { runGoogleAdsSync } from '../src/google-ads/sync';
import { resolveMetaContext } from '../src/meta/context';
import { runMetaSync } from '../src/meta/sync';
import { resolveOrganicContext } from '../src/google-organic/context';
import { runGa4Sync, runSearchConsoleSync } from '../src/google-organic/sync';
import { runNightlyRepull } from '../src/nightly';

const [slug, platform, start, end] = process.argv.slice(2);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PLATFORMS = ['google_ads', 'meta', 'ga4', 'search_console'] as const;

if (!slug || !platform) {
  console.error('Usage: repull <slug> <platform> <start> <end> | repull <slug> --nightly');
  process.exit(1);
}

const [tenant] = await withMaintenance(getMaintenanceDb(), (tx) =>
  tx.select({ id: schema.tenants.id, name: schema.tenants.name }).from(schema.tenants).where(eq(schema.tenants.slug, slug)),
);
if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

if (platform === '--nightly') {
  const result = await runNightlyRepull({ tenantId: tenant.id, trigger: 'manual-nightly', deadlineMs: 600_000 });
  for (const o of result.outcomes) console.log(`${o.platform.padEnd(15)} ${o.status.padEnd(10)} ${o.detail}`);
  process.exit(result.ok ? 0 : 1);
}

if (!(PLATFORMS as readonly string[]).includes(platform) || !start || !end || !DAY.test(start) || !DAY.test(end) || start > end) {
  console.error(`platform must be one of ${PLATFORMS.join(', ')}, and start ≤ end as YYYY-MM-DD.`);
  process.exit(1);
}

const [connection] = await withMaintenance(getMaintenanceDb(), (tx) =>
  tx
    .select({ id: schema.connections.id })
    .from(schema.connections)
    .where(and(eq(schema.connections.tenantId, tenant.id), eq(schema.connections.platform, platform))),
);
if (!connection) throw new Error(`${tenant.name} has no ${platform} connection.`);

const range = { start, end };
const trigger = 'manual-repull';
let line: string;
if (platform === 'google_ads') {
  const r = await runGoogleAdsSync(await resolveGoogleAdsContext(tenant.id, connection.id), { trigger, range, maxClickDays: 0 });
  line = `${r.status}: ${r.dailyMetrics} metric rows`;
} else if (platform === 'meta') {
  const r = await runMetaSync(await resolveMetaContext(tenant.id, connection.id), { trigger, range });
  line = `${r.status}: ${r.dailyMetrics} metric rows`;
} else {
  const context = await resolveOrganicContext(tenant.id, connection.id, platform as 'ga4' | 'search_console');
  const r = platform === 'ga4'
    ? await runGa4Sync(context, { trigger, range })
    : await runSearchConsoleSync(context, { trigger, range });
  line = `${r.status}: ${r.range.start} → ${r.range.end}, ${r.totals} daily rows`;
}
console.log(`${tenant.name} · ${platform} · ${start} → ${end} · ${line}`);
process.exit(0);
