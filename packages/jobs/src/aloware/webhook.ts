import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_ALOWARE_MAPPING,
  normalizeWebhookCall,
  type AlowareMapping,
  type CallRow,
} from '@zeeraa/connectors';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { resolveLeadsForDelivery, upsertCalls } from './writer';

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
  /**
   * Calls joined to a lead on arrival, and the numbers that could not be.
   *
   * Null when the match could not run at all, which is not the same as nothing
   * matching: the call is in either case, and the hourly sweep is the backstop.
   */
  matched: { matched: number; unmatched: number; ambiguous: number } | null;
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
    /*
     * The webhook's own reader, and the same tenant timezone as the import.
     *
     * It shares `normalizeCall` underneath, so a call delivered by both routes
     * still produces byte-identical rows — but it applies the webhook's field
     * names first, and gates on `Type`, `Current Status` and `Disposition
     * Status` before them. Not on `Event`: Aloware sends
     * `OutboundSMS-DispositionCompleted` on calls as well as texts, so the
     * event name describes neither the channel nor the state.
     */
    const result = normalizeWebhookCall(record, tenant.mapping, tenant.timezone);
    if (!result.row) {
      // The reason and the value that caused it, because the rejected value is
      // the actionable half: "not a finished outcome (in-progress)" says
      // exactly which vocabulary to extend, where "not a call" does not.
      count(result.type !== undefined ? `${result.reason} (${result.type})` : result.reason);
      continue;
    }
    rows.push(result.row);
  }

  const accepted =
    rows.length === 0
      ? 0
      : await withJobTenant(tenant.id, (tx) => upsertCalls(tx, tenant.id, rows, 'webhook', null));

  /*
   * Match on arrival, because currency is the point of the webhook.
   *
   * Speed to lead is measured on matched calls, so a call that waits for the
   * next hourly Salesforce sweep is a call the figure cannot see for up to an
   * hour — which defeats pushing it in the first place.
   *
   * **A separate transaction, and best-effort.** The call is the irreplaceable
   * half and the match is not: `resolveCallLeads` runs from every Salesforce
   * sync and will pick up anything missed here within the hour. Sharing the
   * upsert's transaction would trade that safety net for atomicity nobody
   * needs — a deterministic fault in the matching pass would roll back the
   * insert too, Aloware would retry it forever, and a call that could simply
   * have been matched late would never land at all.
   */
  const contactKeys = rows
    .map((row) => row.contactKey)
    .filter((key): key is string => key !== null);

  let matched: CallEventResult['matched'] = null;
  if (accepted > 0 && contactKeys.length > 0) {
    try {
      matched = await withJobTenant(tenant.id, (tx) =>
        resolveLeadsForDelivery(tx, tenant.id, contactKeys),
      );
    } catch (error) {
      console.error(`[aloware] ${slug}: could not match delivered calls to leads:`, error);
    }
  }

  return { accepted, rejected, matched };
}
