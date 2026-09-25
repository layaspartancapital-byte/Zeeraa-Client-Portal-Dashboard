import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_PLATFORM_PRIORITY,
  parseLeadExclusion,
  SalesforceClient,
  type JwtConfig,
  type SalesforceFieldMapping,
} from '@zeeraa/connectors';
import { DEFAULT_REVENUE_TOLERANCE, parseLeadSourceRules, type QualificationBar } from '@zeeraa/core';
import {
  decryptCredentials,
  getMaintenanceDb,
  schema,
  withJobTenant,
  withMaintenance,
} from '@zeeraa/db';
import type { SyncContext } from './sync';
import { parseStageCorrections, parseLenderExclusions, parseStageExclusions, parseStageMerges } from './stage-rules';

/**
 * Assembles a sync context from configuration rather than from constants.
 *
 * The field mapping, the qualification bar, the click-ID priority and which
 * stage MQL corresponds to are all rows. Nothing about Spartan appears here —
 * the next client's org has different field names and a different bar, and
 * neither is a code change.
 */
export async function resolveSalesforceContext(
  tenantId: string,
  connectionId: string,
): Promise<SyncContext> {
  return withJobTenant(tenantId, async (tx) => {
    const [connection] = await tx
      .select()
      .from(schema.connections)
      .where(
        and(eq(schema.connections.tenantId, tenantId), eq(schema.connections.id, connectionId)),
      );

    if (!connection) throw new Error(`No Salesforce connection ${connectionId} for this tenant.`);

    const config = connection.config as {
      audience?: string;
      fieldMapping?: SalesforceFieldMapping;
    };
    if (!config.fieldMapping) {
      throw new Error(
        'The Salesforce connection has no fieldMapping. Nothing can be synced until ' +
          'it names which fields carry which concepts.',
      );
    }

    if (!connection.credentialsEncrypted) {
      throw new Error(
        'The Salesforce connection holds no credentials. Add them through the ' +
          'connection settings — they are encrypted per tenant, never in env vars.',
      );
    }

    const credentials = decryptCredentials<{
      clientId: string;
      username: string;
      privateKeyBase64: string;
    }>(connection.credentialsEncrypted);

    const jwt: JwtConfig = {
      clientId: credentials.clientId,
      username: credentials.username,
      privateKeyBase64: credentials.privateKeyBase64,
      loginUrl: config.audience ?? 'https://login.salesforce.com',
    };

    const settings = await tx
      .select()
      .from(schema.tenantConfig)
      .where(eq(schema.tenantConfig.tenantId, tenantId));
    const byKey = new Map(settings.map((s) => [s.key, s.value as Record<string, unknown>]));

    const mqlBar = byKey.get('mql_bar') ?? {};
    const bar: QualificationBar = {
      minMonthsInBusiness: Number(mqlBar.minMonthsInBusiness ?? 0),
      minMonthlyRevenue: Number(mqlBar.minMonthlyRevenue ?? 0),
      revenueDisagreementTolerance: Number(
        mqlBar.revenueDisagreementTolerance ?? DEFAULT_REVENUE_TOLERANCE,
      ),
    };

    const priority = byKey.get('click_id_platform_priority')?.priority as string[] | undefined;

    // Which leads this platform counts at all. A misconfigured rule set throws
    // here rather than silently ingesting a population the client considers out
    // of scope, or silently ingesting nothing.
    const leadExclusion = parseLeadExclusion(byKey.get('lead_exclusion'));

    // Which stage key MQL is, read from the mapping's derived stages rather
    // than assumed to be called "mql".
    const mqlStageKey = Object.entries(config.fieldMapping.derivedStages ?? {}).find(
      ([, rule]) => rule === 'qualification_minimums',
    )?.[0];

    return {
      tenantId,
      connectionId,
      client: new SalesforceClient(jwt),
      mapping: config.fieldMapping,
      bar,
      clickIdPriority: priority ?? DEFAULT_PLATFORM_PRIORITY,
      leadExclusion,
      mqlStageKey,
      // Both throw on a malformed row, like the lead exclusion: a rule that
      // silently parsed to nothing would count every renewal again.
      stageExclusions: parseStageExclusions(byKey.get('stage_exclusions')),
      stageCorrections: parseStageCorrections(byKey.get('stage_corrections')),
      stageMerges: parseStageMerges(byKey.get('stage_merges')),
      lenderExclusions: parseLenderExclusions(byKey.get('lender_exclusions')),
      // Absent or malformed, only a click ID credits a source: every other lead
      // is Direct & other rather than guessed into a channel.
      leadSources: parseLeadSourceRules(byKey.get('lead_source_rules')),
    } satisfies SyncContext;
  });
}

/** Every tenant with a Salesforce connection, for the scheduled fan-out. */
export async function listSalesforceConnections(): Promise<
  { tenantId: string; connectionId: string }[]
> {
  // Crosses tenants, so it says so. This cannot run on the jobs role:
  // `job_read_connections` is `tenant_id = app.current_tenant_id()` and the
  // scheduler has no tenant yet — that is the question it is asking — so the
  // jobs role reads zero rows and the fan-out dispatches nothing at all.
  //
  // Two uuids per connection, and nothing else. Each resulting sync then runs
  // through `withJobTenant`, scoped to its own tenant.
  return withMaintenance(getMaintenanceDb(), (tx) =>
    tx
      .select({ tenantId: schema.connections.tenantId, connectionId: schema.connections.id })
      .from(schema.connections)
      .where(eq(schema.connections.platform, 'salesforce')),
  );
}
