import { and, eq, isNotNull } from 'drizzle-orm';
import {
  accessTokenUsable,
  linkedInAppFromEnv,
  linkedInConnector,
  refreshLinkedInToken,
  type Connection,
  type Connector,
  type LinkedInConfig,
  type LinkedInCredentials,
} from '@zeeraa/connectors';
import { decryptCredentials, getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';

export type LinkedInContext = {
  tenantId: string;
  connectionId: string;
  connector: Connector;
  connection: Connection;
  /** When the grant stops working and Connect must be pressed again. */
  refreshTokenExpiresAt: string | null;
};

/**
 * The connection, with an access token that works now.
 *
 * The stored access token is used while it has more than five minutes left;
 * after that (60 days from Connect) one is minted from the refresh token for
 * this run and discarded. Nothing is written back: the ingestion role holds
 * no write on `connections`, and the refresh token's expiry does not move
 * when it is used, so the stored grant loses nothing.
 */
export async function resolveLinkedInContext(
  tenantId: string,
  connectionId: string,
  options: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<LinkedInContext> {
  const loaded = await withJobTenant(tenantId, async (tx) => {
    const [connection] = await tx
      .select()
      .from(schema.connections)
      .where(and(eq(schema.connections.tenantId, tenantId), eq(schema.connections.id, connectionId)));
    if (!connection) throw new Error(`No LinkedIn connection ${connectionId} for this tenant.`);
    const [tenant] = await tx.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    if (!tenant) throw new Error(`Tenant ${tenantId} not found.`);
    if (!connection.credentialsEncrypted) {
      throw new Error('The LinkedIn connection holds no grant. Press Connect on the Connections page.');
    }
    return { connection, tenant, grant: decryptCredentials<LinkedInCredentials>(connection.credentialsEncrypted) };
  });

  const now = options.now ?? new Date();
  let accessToken = loaded.grant.accessToken;
  if (!accessTokenUsable(loaded.grant, now)) {
    const fresh = await refreshLinkedInToken(linkedInAppFromEnv(), loaded.grant, { now, fetchImpl: options.fetchImpl });
    accessToken = fresh.accessToken;
  }
  const config = loaded.connection.config as LinkedInConfig;

  return {
    tenantId,
    connectionId,
    connector: linkedInConnector(),
    refreshTokenExpiresAt: loaded.grant.refreshTokenExpiresAt,
    connection: {
      id: loaded.connection.id,
      tenantId,
      platform: 'linkedin_ads',
      accountIdentifier: loaded.connection.accountIdentifier,
      credentials: { accessToken },
      config: config as unknown as Record<string, unknown>,
      tenantTimezone: loaded.tenant.timezone,
      tenantCurrency: loaded.tenant.currency,
    },
  };
}

/**
 * Every tenant whose LinkedIn connection holds a grant, for the hourly and
 * nightly fan-outs. A row nobody has connected yet is not dispatched: it
 * would fail every hour on the absence of a token, which is not news.
 */
export async function listLinkedInConnections(): Promise<{ tenantId: string; connectionId: string }[]> {
  return withMaintenance(getMaintenanceDb(), (tx) =>
    tx
      .select({ tenantId: schema.connections.tenantId, connectionId: schema.connections.id })
      .from(schema.connections)
      .where(and(eq(schema.connections.platform, 'linkedin_ads'), isNotNull(schema.connections.credentialsEncrypted))),
  );
}
