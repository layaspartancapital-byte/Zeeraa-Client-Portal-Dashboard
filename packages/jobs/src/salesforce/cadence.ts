import { and, eq } from 'drizzle-orm';
import { schema, withJobTenant } from '@zeeraa/db';
import { parseBusinessHours, salesforceSyncDue } from '@zeeraa/core';
import { listSalesforceConnections } from './context';

/**
 * The tenants a Salesforce cron tick at `at` should read.
 *
 * Every tenant on the first tick of the hour, and a tenant whose desk is open
 * (`lead_response_hours`) on the others — `salesforceSyncDue` in core, which
 * the dashboard's own refresh follows too. The hours are read on the jobs role
 * under each tenant's own scope, like the sync that follows.
 */
export async function salesforceTenantsDue(at: Date): Promise<string[]> {
  const tenants = [...new Set((await listSalesforceConnections()).map((c) => c.tenantId))];
  const due: string[] = [];
  for (const tenantId of tenants) {
    const [row] = await withJobTenant(tenantId, (tx) =>
      tx
        .select({ value: schema.tenantConfig.value })
        .from(schema.tenantConfig)
        .where(
          and(eq(schema.tenantConfig.tenantId, tenantId), eq(schema.tenantConfig.key, 'lead_response_hours')),
        )
        .limit(1),
    );
    if (salesforceSyncDue(at, parseBusinessHours(row?.value))) due.push(tenantId);
  }
  return due;
}
