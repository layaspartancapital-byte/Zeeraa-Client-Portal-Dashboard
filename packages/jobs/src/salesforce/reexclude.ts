import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@zeeraa/db';
import {
  ruleClause,
  unclassifiedClause,
  type LeadExclusionConfig,
  type SalesforceClient,
} from '@zeeraa/connectors';
import { affectedRows } from '../affected-rows';

/** The reason a lead with no rule and no inbound signal is excluded under. */
export const UNCLASSIFIED_REASON = 'unclassified';

/** The reasons `markLeadsNowExcluded` sets, which the sync's reset must keep. */
export function leadRuleReasons(config: LeadExclusionConfig): string[] {
  return config.enabled ? [...config.rules.map((r) => r.key), UNCLASSIFIED_REASON] : [];
}

/**
 * Marks stored leads that now fall under an exclusion rule (30 October 2026).
 *
 * The sync reads only leads the exclusion admits — the rules are in its WHERE
 * clause — so a lead that comes under a rule *after* it was ingested is never
 * read again, and stays counted. A merge does it: Salesforce gives the
 * survivor the earliest record's `CreatedDate` and can leave it with no lead
 * source, so an inbound lead merged with a cold-list record dated 8 September
 * now matches "the cold-list bulk load of 8 September" in Salesforce and
 * nowhere here. September's reconciliation found exactly that lead.
 *
 * Asks Salesforce, rule by rule, which leads modified since `since` (every
 * lead, with null) now match, and marks each stored one with that rule's key —
 * a lead already excluded for another reason (merged, a renewal) keeps it.
 * Then the same for leads matching no rule and carrying no inbound signal.
 */
export async function markLeadsNowExcluded(
  client: SalesforceClient,
  tx: Database,
  tenantId: string,
  config: LeadExclusionConfig,
  since: Date | null,
): Promise<Record<string, number>> {
  if (!config.enabled) return {};
  const window = since ? ` AND SystemModstamp > ${since.toISOString().replace(/\.\d{3}Z$/, 'Z')}` : '';
  const checks: [string, string][] = config.rules.map((rule) => [rule.key, ruleClause(rule)]);
  const residue = unclassifiedClause(config);
  if (residue) checks.push([UNCLASSIFIED_REASON, residue]);

  const marked: Record<string, number> = {};
  for (const [reason, clause] of checks) {
    const ids = (await client.query<{ Id: string }>(`SELECT Id FROM Lead WHERE ${clause}${window}`)).map((r) => r.Id);
    let n = 0;
    for (let i = 0; i < ids.length; i += 1000) {
      n += affectedRows(
        await tx
          .update(schema.leads)
          .set({ excludedReason: reason, updatedAt: new Date() })
          .where(
            and(
              eq(schema.leads.tenantId, tenantId),
              inArray(schema.leads.externalId, ids.slice(i, i + 1000)),
              sql`${schema.leads.excludedReason} is null`,
            ),
          ),
      );
    }
    if (n > 0) marked[reason] = n;
  }
  return marked;
}
