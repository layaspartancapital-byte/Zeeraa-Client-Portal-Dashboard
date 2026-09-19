import { and, eq, inArray } from 'drizzle-orm';
import {
  GoogleOrganicClient,
  type Ga4Config,
  type GoogleOrganicCredentials,
  type SearchConsoleConfig,
} from '@zeeraa/connectors';
import {
  decryptCredentials,
  getMaintenanceDb,
  schema,
  withJobTenant,
  withMaintenance,
} from '@zeeraa/db';

/**
 * GA4 and Search Console read the *Google Ads* credential.
 *
 * One OAuth client, one refresh token, one person's consent, three APIs. The
 * alternative is three tokens to rotate, store and forget, for no gain: they
 * are the same Google account either way.
 *
 * The consequence to know about: the token carries the scopes it was granted
 * and never gains more, so connecting GA4 after Google Ads means re-running
 * consent — not editing a config row. `set-credentials spartan google_ads`
 * rewrites the token all three read.
 */
export type OrganicPlatform = 'ga4' | 'search_console';

export type OrganicContext = {
  tenantId: string;
  connectionId: string;
  platform: OrganicPlatform;
  client: GoogleOrganicClient;
  tenantTimezone: string;
  /** Whichever config the platform needs; the caller narrows it. */
  config: Ga4Config & SearchConsoleConfig;
  accountIdentifier: string;
};

export async function resolveOrganicContext(
  tenantId: string,
  connectionId: string,
  platform: OrganicPlatform,
): Promise<OrganicContext> {
  return withJobTenant(tenantId, async (tx) => {
    const [connection] = await tx
      .select()
      .from(schema.connections)
      .where(
        and(eq(schema.connections.tenantId, tenantId), eq(schema.connections.id, connectionId)),
      );
    if (!connection) throw new Error(`No ${platform} connection ${connectionId} for this tenant.`);

    const [tenant] = await tx.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    if (!tenant) throw new Error(`Tenant ${tenantId} not found.`);

    // Deliberately the Google Ads row: that is where the token lives.
    const [googleAds] = await tx
      .select()
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.tenantId, tenantId),
          eq(schema.connections.platform, 'google_ads'),
        ),
      );
    if (!googleAds?.credentialsEncrypted) {
      throw new Error(
        `${platform} reads the Google Ads credential, and this tenant's google_ads ` +
          'connection holds none. Store one with `pnpm --filter @zeeraa/db ' +
          'set-credentials <tenant> google_ads` — and make sure the token was ' +
          'granted the analytics.readonly and webmasters.readonly scopes, which a ' +
          'token issued for Google Ads alone was not.',
      );
    }

    const credentials = decryptCredentials<GoogleOrganicCredentials>(
      googleAds.credentialsEncrypted,
    );

    return {
      tenantId,
      connectionId,
      platform,
      client: new GoogleOrganicClient(credentials),
      tenantTimezone: tenant.timezone,
      config: connection.config as Ga4Config & SearchConsoleConfig,
      accountIdentifier: connection.accountIdentifier,
    };
  });
}

/** Every tenant with one of these connections, for the nightly fan-out. */
export async function listOrganicConnections(
  platform: OrganicPlatform,
): Promise<{ tenantId: string; connectionId: string }[]> {
  // Crosses tenants, so it says so — the scheduler has no tenant yet, which is
  // the question it is asking. Two uuids per connection and nothing else; each
  // sync then runs through `withJobTenant`.
  return withMaintenance(getMaintenanceDb(), (tx) =>
    tx
      .select({ tenantId: schema.connections.tenantId, connectionId: schema.connections.id })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.platform, platform),
          // Unconfigured rows are placeholders for a connector that was not
          // built yet; dispatching against them would spend a run per tenant
          // discovering there is no property id.
          inArray(schema.connections.status, ['healthy', 'degraded', 'waiting_on_client']),
        ),
      ),
  );
}
