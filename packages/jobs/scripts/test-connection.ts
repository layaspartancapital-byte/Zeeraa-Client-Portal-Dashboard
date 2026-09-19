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
import {
  MetaClient,
  checkMetaReportingZone,
  normalizeMetaAccount,
  type MetaAccountRow,
  type MetaConfig,
  type MetaCredentials,
} from '@zeeraa/connectors';
import {
  ga4Client,
  searchConsoleClient,
  GoogleOrganicApiError,
} from '@zeeraa/connectors';
import { resolveGoogleAdsContext } from '../src/google-ads/context';
import { resolveMetaContext } from '../src/meta/context';
import { resolveOrganicContext } from '../src/google-organic/context';

const SUPPORTED = ['google_ads', 'meta', 'ga4', 'search_console'] as const;

/**
 * GA4 and Search Console have no `Connector` of their own — they are two
 * reports on the Google Ads credential rather than a platform with entities and
 * spend — so their test is written here: ask each API for the smallest thing it
 * will answer, and translate the one failure that matters into words.
 */
async function testOrganic(
  platform: 'ga4' | 'search_console',
  tenantId: string,
  connectionId: string,
): Promise<{ health: import('@zeeraa/connectors').ConnectionHealth; accountIdentifier: string }> {
  const context = await resolveOrganicContext(tenantId, connectionId, platform);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const range = { start: yesterday, end: yesterday };

  try {
    if (platform === 'ga4') {
      console.log(`  property id:     ${context.config.propertyId ?? '(none configured)'}`);
      if (!context.config.propertyId) {
        return {
          health: { state: 'not_configured' as never, detail: 'No GA4 property id configured.' },
          accountIdentifier: context.accountIdentifier,
        };
      }
      const rows = await ga4Client(context.client, context.config).daily(range);
      console.log(`  yesterday:       ${rows.length} row(s), ${rows[0]?.sessions ?? 0} sessions`);
      return {
        health: { state: 'healthy', accountName: `GA4 property ${context.config.propertyId}` },
        accountIdentifier: String(context.config.propertyId),
      };
    }

    console.log(`  site url:        ${context.config.siteUrl ?? '(none configured)'}`);
    const gsc = searchConsoleClient(context.client, context.config);
    const sites = await gsc.sites();
    const entries = sites.siteEntry ?? [];
    for (const site of entries) {
      console.log(`  visible site:    ${site.permissionLevel}  ${site.siteUrl}`);
    }
    // A URL-prefix property and a `sc-domain:` property are different
    // properties. Matching loosely here would report healthy and then read an
    // empty window forever.
    const match = entries.find((site) => site.siteUrl === context.config.siteUrl);
    if (!match) {
      return {
        health: {
          state: 'waiting_on_client',
          detail:
            `The token can see ${entries.length} propert${entries.length === 1 ? 'y' : 'ies'}, ` +
            `and ${context.config.siteUrl} is not among them. Search Console matches the site ` +
            'URL exactly — a trailing slash, http versus https, and the sc-domain: form are all ' +
            'different properties.',
        },
        accountIdentifier: context.accountIdentifier,
      };
    }
    return {
      health: { state: 'healthy', accountName: match.siteUrl },
      accountIdentifier: match.siteUrl,
    };
  } catch (error) {
    if (error instanceof GoogleOrganicApiError) {
      return {
        health: {
          state: error.waitingOnClient ? 'waiting_on_client' : error.retryable ? 'degraded' : 'failing',
          detail: error.detail,
        },
        accountIdentifier: context.accountIdentifier,
      };
    }
    throw error;
  }
}

const [slug, platform] = process.argv.slice(2);
if (!slug || !platform) {
  throw new Error('Usage: tsx scripts/test-connection.ts <tenant-slug> <platform>');
}
if (!(SUPPORTED as readonly string[]).includes(platform)) {
  throw new Error(
    `No connection test wired for platform "${platform}". Wired: ${SUPPORTED.join(', ')}.`,
  );
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

  // The organic sources take a different path entirely: no connector, no
  // entities, and a credential that belongs to another connection row.
  if (platform === 'ga4' || platform === 'search_console') {
    const { health, accountIdentifier } = await testOrganic(platform, tenantId, connectionId);
    console.log('\n  testConnection returned:');
    console.log(JSON.stringify(health, null, 4).replace(/^/gm, '    '));

    const organicStatus = health.state === 'healthy' ? 'healthy' : health.state;
    await withMaintenance(db, async (tx) => {
      await tx
        .update(schema.connections)
        .set({
          status: organicStatus,
          accountIdentifier,
          lastError: health.state === 'failing' ? ('detail' in health ? health.detail : null) : null,
          blockedReason:
            health.state === 'waiting_on_client' && 'detail' in health ? health.detail : null,
          blockedSince: health.state === 'waiting_on_client' ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(schema.connections.id, connectionId));
    });
    console.log(`\n  connection status written: ${organicStatus}`);
    if (health.state === 'failing' || health.state === 'waiting_on_client') process.exitCode = 1;
  } else {

  const context =
    platform === 'meta'
      ? await resolveMetaContext(tenantId, connectionId)
      : await resolveGoogleAdsContext(tenantId, connectionId);

  // The account identifier to write back afterwards. Each platform calls it
  // something different and neither is "the account id".
  let accountIdentifier: string;

  if (platform === 'meta') {
    const config = context.connection.config as unknown as MetaConfig;
    accountIdentifier = String(config.adAccountId);
    console.log(`  ad account:      ${config.adAccountId}`);
    console.log(`  api version:     ${config.apiVersion ?? 'default'}`);
    console.log(`  conversions:     ${(config.conversionActionTypes ?? ['lead']).join(', ')}`);
    console.log(`  clicks column:   ${config.clickMetric ?? 'inline_link_clicks'}`);

    // The same read testConnection makes, run once more so the figures behind
    // the verdict are visible rather than summarised into a single word.
    const client = new MetaClient(
      context.connection.credentials as unknown as MetaCredentials,
      config,
    );
    try {
      const account = normalizeMetaAccount(
        await client.node<MetaAccountRow>(client.account, {
          fields: 'id,name,account_status,currency,timezone_name',
        }),
      );
      if (account) {
        const zone = checkMetaReportingZone(account.timeZone, context.connection.tenantTimezone);
        console.log(
          `\n  account:         ${account.name} (${account.externalAccountId}), currency ` +
            `${account.currency ?? 'not reported'}, timezone ${account.timeZone ?? 'not reported'}`,
        );
        console.log(`  account status:  ${account.accountStatus}`);
        console.log(
          `  timezone check:  ${zone.aligned ? `aligned (${zone.zone})` : `MISALIGNED — account ${zone.accountZone}, tenant ${zone.tenantZone}`}`,
        );
      }
    } catch (error) {
      console.log(
        `\n  account read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    const config = context.connection.config as unknown as GoogleAdsConfig;
    accountIdentifier = config.customerId;
    console.log(`  customer id:     ${config.customerId}`);
    console.log(`  login customer:  ${config.loginCustomerId ?? '(none — queried directly)'}`);
    console.log(`  api version:     ${config.apiVersion ?? 'default'}`);

    const client = new GoogleAdsClient(
      context.connection.credentials as unknown as GoogleAdsCredentials,
      config,
    );
    try {
      const rows = await client.search(accountQuery());
      const account = rows[0] ? normalizeAccount(rows[0]) : null;
      if (account) {
        const zone = checkReportingZone(account.timeZone, context.connection.tenantTimezone);
        console.log(
          `\n  account:         ${account.name} (${account.externalAccountId}), currency ` +
            `${account.currency ?? 'not reported'}, timezone ${account.timeZone ?? 'not reported'}`,
        );
        console.log(
          `  timezone check:  ${zone.aligned ? `aligned (${zone.zone})` : `MISALIGNED — account ${zone.accountZone}, tenant ${zone.tenantZone}`}`,
        );
      }
    } catch (error) {
      console.log(
        `\n  account query failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
        accountIdentifier,
        lastError: health.state === 'failing' ? ('detail' in health ? health.detail : null) : null,
        blockedReason:
          health.state === 'waiting_on_client' && 'detail' in health ? health.detail : null,
        blockedSince: health.state === 'waiting_on_client' ? new Date() : null,
        // The config is left exactly as configured. This script reads an
        // account; it is not a place to quietly rewrite how one is read.
        updatedAt: new Date(),
      })
      .where(eq(schema.connections.id, connectionId));
  });
  console.log(`\n  connection status written: ${status}`);

  if (health.state === 'failing' || health.state === 'waiting_on_client') process.exitCode = 1;
  }
} finally {
  await close();
  const { closeConnections } = await import('@zeeraa/db');
  await closeConnections();
}
