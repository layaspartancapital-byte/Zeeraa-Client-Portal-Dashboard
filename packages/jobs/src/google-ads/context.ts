import { and, eq } from 'drizzle-orm';
import {
  googleAdsConnector,
  type Connection,
  type Connector,
  type GoogleAdsConfig,
  type GoogleAdsCredentials,
} from '@zeeraa/connectors';
import {
  decryptCredentials,
  getMaintenanceDb,
  schema,
  withJobTenant,
  withMaintenance,
} from '@zeeraa/db';

/**
 * Assembles a Google Ads sync context from configuration.
 *
 * Every credential is per tenant, including the manager account id and the
 * OAuth client. Spartan reaches their ad account through their own MCC rather
 * than a Zeeraa one, and since 9 September 2026 the API access level belongs to
 * the Google Cloud project behind that OAuth client — so there is no
 * agency-level piece to hoist into an environment variable even if a later
 * client happened to share one.
 */
export type GoogleAdsContext = {
  tenantId: string;
  connectionId: string;
  connection: Connection;
  connector: Connector;
};

export async function resolveGoogleAdsContext(
  tenantId: string,
  connectionId: string,
): Promise<GoogleAdsContext> {
  return withJobTenant(tenantId, async (tx) => {
    const [connection] = await tx
      .select()
      .from(schema.connections)
      .where(
        and(eq(schema.connections.tenantId, tenantId), eq(schema.connections.id, connectionId)),
      );
    if (!connection) throw new Error(`No Google Ads connection ${connectionId} for this tenant.`);

    const [tenant] = await tx
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId));
    if (!tenant) throw new Error(`Tenant ${tenantId} not found.`);

    if (!connection.credentialsEncrypted) {
      throw new Error(
        'The Google Ads connection holds no credentials. Generate a refresh token ' +
          'with `pnpm --filter @zeeraa/connectors google-ads-token` and store it ' +
          'through the connection settings — encrypted per tenant, never in env vars.',
      );
    }

    const credentials = decryptCredentials<GoogleAdsCredentials>(connection.credentialsEncrypted);
    const config = connection.config as GoogleAdsConfig;

    return {
      tenantId,
      connectionId,
      connector: googleAdsConnector(),
      connection: {
        id: connection.id,
        tenantId,
        platform: 'google_ads',
        accountIdentifier: connection.accountIdentifier,
        credentials: credentials as unknown as Record<string, unknown>,
        config: config as unknown as Record<string, unknown>,
        tenantTimezone: tenant.timezone,
        tenantCurrency: tenant.currency,
      },
    };
  });
}

/** Every tenant with a Google Ads connection, for the nightly fan-out. */
export async function listGoogleAdsConnections(): Promise<
  { tenantId: string; connectionId: string }[]
> {
  // Crosses tenants, so it says so: `withMaintenance` is the only way, it needs
  // a role the ingestion connection does not have, and it greps.
  //
  // This cannot run on the jobs role. `job_read_connections` is
  // `tenant_id = app.current_tenant_id()`, and the scheduler has no tenant yet
  // — that is the question it is asking — so the jobs role reads zero rows and
  // the nightly fan-out dispatches nothing at all. Failing closed is correct;
  // asking on the wrong connection was the bug.
  //
  // Two uuids per connection, and nothing else. Each resulting sync then runs
  // through `withJobTenant`, scoped to its own tenant.
  return withMaintenance(getMaintenanceDb(), (tx) =>
    tx
      .select({ tenantId: schema.connections.tenantId, connectionId: schema.connections.id })
      .from(schema.connections)
      .where(eq(schema.connections.platform, 'google_ads')),
  );
}
