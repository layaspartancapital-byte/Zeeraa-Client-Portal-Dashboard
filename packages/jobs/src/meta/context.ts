import { and, eq } from 'drizzle-orm';
import {
  metaConnector,
  type Connection,
  type Connector,
  type MetaConfig,
  type MetaCredentials,
} from '@zeeraa/connectors';
import {
  decryptCredentials,
  getMaintenanceDb,
  schema,
  withJobTenant,
  withMaintenance,
} from '@zeeraa/db';

/**
 * Assembles a Meta sync context from configuration.
 *
 * The credential is a system user token belonging to the client's Business
 * Manager, stored encrypted on the connection row like every other. It is
 * deliberately not read from an environment variable at request time: a token
 * in the environment is one token for the deployment, and this platform is
 * multi-tenant — the second client would silently sync against the first
 * client's ad account.
 */
export type MetaContext = {
  tenantId: string;
  connectionId: string;
  connection: Connection;
  connector: Connector;
};

export async function resolveMetaContext(
  tenantId: string,
  connectionId: string,
): Promise<MetaContext> {
  return withJobTenant(tenantId, async (tx) => {
    const [connection] = await tx
      .select()
      .from(schema.connections)
      .where(
        and(eq(schema.connections.tenantId, tenantId), eq(schema.connections.id, connectionId)),
      );
    if (!connection) throw new Error(`No Meta connection ${connectionId} for this tenant.`);

    const [tenant] = await tx.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    if (!tenant) throw new Error(`Tenant ${tenantId} not found.`);

    if (!connection.credentialsEncrypted) {
      throw new Error(
        'The Meta connection holds no credentials. Store the system user token ' +
          'with `pnpm --filter @zeeraa/db set-credentials <tenant> meta`.',
      );
    }

    const credentials = decryptCredentials<MetaCredentials>(connection.credentialsEncrypted);
    const config = connection.config as MetaConfig;

    return {
      tenantId,
      connectionId,
      connector: metaConnector(),
      connection: {
        id: connection.id,
        tenantId,
        platform: 'meta',
        accountIdentifier: connection.accountIdentifier,
        credentials: credentials as unknown as Record<string, unknown>,
        config: config as unknown as Record<string, unknown>,
        tenantTimezone: tenant.timezone,
        tenantCurrency: tenant.currency,
      },
    };
  });
}

/** Every tenant with a Meta connection, for the nightly fan-out. */
export async function listMetaConnections(): Promise<
  { tenantId: string; connectionId: string }[]
> {
  // Crosses tenants, so it says so. Same reasoning as the Google Ads fan-out:
  // the scheduler has no tenant yet — that is the question it is asking — so on
  // the jobs role every policy evaluates false and it would dispatch nothing at
  // all while reporting success. Two uuids per connection and nothing else;
  // each sync then runs through `withJobTenant`.
  return withMaintenance(getMaintenanceDb(), (tx) =>
    tx
      .select({ tenantId: schema.connections.tenantId, connectionId: schema.connections.id })
      .from(schema.connections)
      .where(eq(schema.connections.platform, 'meta')),
  );
}
