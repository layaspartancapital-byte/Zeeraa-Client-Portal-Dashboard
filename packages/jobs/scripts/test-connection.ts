/**
 * Runs a connector's `testConnection` against the live account and records the
 * result on the connection row.
 *
 *   pnpm --filter @zeeraa/jobs test-connection <tenant-slug> <platform>
 *
 * The read happens on the ingestion role, exactly as a sync would, so a
 * credential that works here works there. The write happens on maintenance:
 * `zeeraa_jobs` holds SELECT on `connections` and nothing more, deliberately —
 * a connector that could rewrite its own connection row is a connector that can
 * hide its own failure.
 *
 * `degraded` is a real answer, not a soft failure. An ad account reporting days
 * in a different zone from the tenant's still produces usable data; it produces
 * data whose day boundaries are off by up to a day, and that is a fact to state
 * once rather than discover from a reconciliation.
 */
import { and, eq } from 'drizzle-orm';
import { getOwnerDb, schema, withMaintenance } from '@zeeraa/db';
import {
  GoogleAdsClient,
  accountQuery,
  checkReportingZone,
  normalizeAccount,
  type GoogleAdsConfig,
  type GoogleAdsCredentials,
} from '@zeeraa/connectors';
import { resolveGoogleAdsContext } from '../src/google-ads/context';

const [slug, platform] = process.argv.slice(2);
if (!slug || !platform) {
  throw new Error('Usage: tsx scripts/test-connection.ts <tenant-slug> <platform>');
}
if (platform !== 'google_ads') {
  throw new Error(`No connection test wired for platform "${platform}".`);
}

const { db, close } = getOwnerDb();

try {
  const { tenantId, connectionId } = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx
      .select({ id: schema.tenants.id, name: schema.tenants.name, timezone: schema.tenants.timezone })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

    const [connection] = await tx
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(
        and(eq(schema.connections.tenantId, tenant.id), eq(schema.connections.platform, platform)),
      );
    if (!connection) throw new Error(`${tenant.name} has no ${platform} connection row.`);

    console.log(`${tenant.name} → ${platform}`);
    console.log(`  tenant timezone: ${tenant.timezone}`);
    return { tenantId: tenant.id, connectionId: connection.id };
  });

  const context = await resolveGoogleAdsContext(tenantId, connectionId);
  const config = context.connection.config as unknown as GoogleAdsConfig;
  console.log(`  customer id:     ${config.customerId}`);
  console.log(`  login customer:  ${config.loginCustomerId ?? '(none — queried directly)'}`);
  console.log(`  api version:     ${config.apiVersion ?? 'default'}`);

  // The same query testConnection makes, run once more so the figures behind
  // the verdict are visible rather than summarised into a single word.
  const client = new GoogleAdsClient(
    context.connection.credentials as unknown as GoogleAdsCredentials,
    config,
  );
  let accountLine = '(account query not reached)';
  try {
    const rows = await client.search(accountQuery());
    const account = rows[0] ? normalizeAccount(rows[0]) : null;
    if (account) {
      const zone = checkReportingZone(account.timeZone, context.connection.tenantTimezone);
      accountLine =
        `${account.name} (${account.externalAccountId}), currency ` +
        `${account.currency ?? 'not reported'}, timezone ${account.timeZone ?? 'not reported'}`;
      console.log(`\n  account:         ${accountLine}`);
      console.log(
        `  timezone check:  ${zone.aligned ? `aligned (${zone.zone})` : `MISALIGNED — account ${zone.accountZone}, tenant ${zone.tenantZone}`}`,
      );
    }
  } catch (error) {
    console.log(`\n  account query failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const health = await context.connector.testConnection(context.connection);
  console.log('\n  testConnection returned:');
  console.log(JSON.stringify(health, null, 4).replace(/^/gm, '    '));

  const status = health.state === 'healthy' ? 'healthy' : health.state;
  await withMaintenance(db, async (tx) => {
    await tx
      .update(schema.connections)
      .set({
        status,
        accountIdentifier: config.customerId,
        lastError: health.state === 'failing' ? ('detail' in health ? health.detail : null) : null,
        blockedReason:
          health.state === 'waiting_on_client' && 'detail' in health ? health.detail : null,
        blockedSince: health.state === 'waiting_on_client' ? new Date() : null,
        config: { ...config, accountTimezone: config.accountTimezone },
        updatedAt: new Date(),
      })
      .where(eq(schema.connections.id, connectionId));
  });
  console.log(`\n  connection status written: ${status}`);

  if (health.state === 'failing' || health.state === 'waiting_on_client') process.exitCode = 1;
} finally {
  await close();
  const { closeConnections } = await import('@zeeraa/db');
  await closeConnections();
}
