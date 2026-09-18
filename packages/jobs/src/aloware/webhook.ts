import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_ALOWARE_MAPPING,
  normalizeCall,
  type AlowareMapping,
  type CallRow,
} from '@zeeraa/connectors';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { upsertCalls } from './writer';

/**
 * Ingests call events posted by Aloware.
 *
 * Lives here rather than in the route handler for two reasons: the web app has
 * no business talking to a connector directly, and this is the same shape as
 * every other ingestion path in this package — a maintenance read to find the
 * tenant, then `withJobTenant` for every write, so a malformed payload cannot
 * reach a second client's data however it is shaped.
 *
 * Idempotent by construction rather than by bookkeeping: the upsert key is
 * Aloware's Communication ID, so a re-delivery overwrites the first copy with
 * the same values and there is nothing to look up first.
 */
export type CallEventResult = {
  accepted: number;
  /** Records that were not usable calls, with why and how many. */
  rejected: { reason: string; count: number }[];
};

export async function ingestCallEvents(
  slug: string,
  records: readonly Record<string, unknown>[],
): Promise<CallEventResult | null> {
  /*
   * The tenant lookup runs on the maintenance role, reading three columns.
   *
   * The same legitimate use as the cron scheduler's: this is orchestration —
   * deciding which tenant a post belongs to — and every write below is scoped
   * by `withJobTenant`.
   */
  const tenant = await withMaintenance(getMaintenanceDb(), async (tx) => {
    const [row] = await tx
      .select({ id: schema.tenants.id, timezone: schema.tenants.timezone })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    if (!row) return null;

    // Column names and the disposition vocabulary are configuration, so the
    // webhook and the CSV import cannot drift apart in how they read a call.
    const [config] = await tx
      .select({ value: schema.tenantConfig.value })
      .from(schema.tenantConfig)
      .where(and(eq(schema.tenantConfig.tenantId, row.id), eq(schema.tenantConfig.key, 'aloware')));

    return {
      id: row.id,
      timezone: row.timezone,
      mapping: {
        ...DEFAULT_ALOWARE_MAPPING,
        ...((config?.value as Partial<AlowareMapping>) ?? {}),
      } as AlowareMapping,
    };
  });

  if (!tenant) return null;

  const rows: CallRow[] = [];
  const rejected: { reason: string; count: number }[] = [];
  const count = (reason: string) => {
    const existing = rejected.find((r) => r.reason === reason);
    if (existing) existing.count += 1;
    else rejected.push({ reason, count: 1 });
  };

  for (const record of records) {
    // The same normaliser and the same tenant timezone as the import: a call
    // must not land at a different instant depending on which route carried it.
    const result = normalizeCall(record, tenant.mapping, tenant.timezone);
    if (!result.row) {
      count(result.type !== undefined ? `not a call (${result.type})` : result.reason);
      continue;
    }
    rows.push(result.row);
  }

  const accepted =
    rows.length === 0
      ? 0
      : await withJobTenant(tenant.id, (tx) => upsertCalls(tx, tenant.id, rows, 'webhook', null));

  return { accepted, rejected };
}
