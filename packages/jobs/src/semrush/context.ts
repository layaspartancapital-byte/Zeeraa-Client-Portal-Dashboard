import { and, eq, inArray } from 'drizzle-orm';
import { SemrushClient } from '@zeeraa/connectors';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';

/**
 * The Semrush connection: which project, which database, which tracking
 * campaign, and how much of Zeeraa's unit allowance this tenant may spend.
 *
 * The API key is not on the row. It is Zeeraa's account key
 * (`SEMRUSH_API_KEY`), metered across every client, so it is the
 * environment's; what belongs to a tenant is its project.
 */
export type SemrushConfig = {
  /** The Semrush project, e.g. 29644497. Site Audit reads it. */
  projectId: number;
  /** The domain the analytics reports ask about, without `www.`. */
  domain: string;
  /** Semrush's regional database. */
  database: string;
  /** Position Tracking campaign, `{projectId}_{n}`. Null until it is recorded. */
  trackingCampaignId?: string | null;
  /** The tracked URL with Semrush's mask, e.g. `*.spartancapitalgroup.com/*`. */
  trackingUrl?: string | null;
  /** Keywords in the tracking campaign; tracked positions cost 100 units each. */
  trackedKeywords?: number;
  /** Units this tenant may spend in any 365 days. */
  annualUnitBudget?: number;
  /** Units one sync run may spend. */
  maxUnitsPerRun?: number;
};

export const DEFAULT_ANNUAL_UNIT_BUDGET = 400_000;
export const DEFAULT_MAX_UNITS_PER_RUN = 25_000;

export type SemrushContext = {
  tenantId: string;
  connectionId: string;
  client: SemrushClient;
  tenantTimezone: string;
  config: SemrushConfig;
};

export async function resolveSemrushContext(
  tenantId: string,
  connectionId: string,
  options: { apiKey?: string; client?: SemrushClient } = {},
): Promise<SemrushContext> {
  return withJobTenant(tenantId, async (tx) => {
    const [connection] = await tx
      .select()
      .from(schema.connections)
      .where(and(eq(schema.connections.tenantId, tenantId), eq(schema.connections.id, connectionId)));
    if (!connection) throw new Error(`No Semrush connection ${connectionId} for this tenant.`);
    const [tenant] = await tx.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    if (!tenant) throw new Error(`Tenant ${tenantId} not found.`);

    const config = connection.config as Partial<SemrushConfig>;
    if (!config.projectId || !config.domain || !config.database) {
      throw new Error(
        'The Semrush connection has no projectId, domain or database. Record them with ' +
          '`pnpm --filter @zeeraa/db configure-semrush <tenant> --project <id> --domain <domain>`.',
      );
    }
    const apiKey = options.apiKey ?? process.env.SEMRUSH_API_KEY ?? '';
    return {
      tenantId,
      connectionId,
      client: options.client ?? new SemrushClient(apiKey),
      tenantTimezone: tenant.timezone,
      config: config as SemrushConfig,
    };
  });
}

/** Every tenant with a configured Semrush connection, for the nightly fan-out. */
export async function listSemrushConnections(): Promise<{ tenantId: string; connectionId: string }[]> {
  // Crosses tenants to ask which tenants there are; each sync then runs
  // through `withJobTenant`.
  return withMaintenance(getMaintenanceDb(), (tx) =>
    tx
      .select({ tenantId: schema.connections.tenantId, connectionId: schema.connections.id })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.platform, 'semrush'),
          inArray(schema.connections.status, ['healthy', 'degraded', 'waiting_on_client']),
        ),
      ),
  );
}
