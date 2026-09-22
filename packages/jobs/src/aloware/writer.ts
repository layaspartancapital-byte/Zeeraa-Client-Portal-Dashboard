import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@zeeraa/db';
import type { CallRow } from '@zeeraa/connectors';

/**
 * Writing calls into Postgres.
 *
 * Upsert on (tenant, Communication ID), which is the whole reason the CSV
 * history and the live webhook can coexist: a call delivered twice by two
 * routes is one row. A webhook re-delivery — which Aloware does on any
 * non-2xx, and sometimes anyway — costs nothing.
 */

/** Postgres caps a statement at 65,535 bound parameters. */
const PARAMETER_BUDGET = 60_000;

export async function upsertCalls(
  tx: Database,
  tenantId: string,
  rows: readonly CallRow[],
  source: 'csv_import' | 'webhook',
  syncRunId: string | null,
): Promise<number> {
  if (rows.length === 0) return 0;

  // Last one wins within a batch, matching what the upsert would do had the
  // rows arrived in separate statements. An export can contain a call twice.
  const deduped = [...new Map(rows.map((row) => [row.externalId, row])).values()];
  const columns = 16;
  const size = Math.max(1, Math.floor(PARAMETER_BUDGET / columns));

  let written = 0;
  for (let i = 0; i < deduped.length; i += size) {
    const batch = deduped.slice(i, i + size);
    const result = await tx
      .insert(schema.calls)
      .values(
        batch.map((row) => ({
          tenantId,
          externalId: row.externalId,
          occurredAt: row.occurredAt,
          direction: row.direction,
          outcome: row.outcome,
          disposition: row.disposition,
          answeredBriefly: row.answeredBriefly,
          talkTimeSeconds: row.talkTimeSeconds === null ? null : String(row.talkTimeSeconds),
          durationSeconds: row.durationSeconds === null ? null : String(row.durationSeconds),
          contactNumber: row.contactNumber,
          contactKey: row.contactKey,
          contactExternalId: row.contactExternalId,
          agentName: row.agentName,
          source,
          syncRunId,
          updatedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: [schema.calls.tenantId, schema.calls.externalId],
        set: {
          occurredAt: sql`excluded.occurred_at`,
          direction: sql`excluded.direction`,
          outcome: sql`excluded.outcome`,
          disposition: sql`excluded.disposition`,
          answeredBriefly: sql`excluded.answered_briefly`,
          talkTimeSeconds: sql`excluded.talk_time_seconds`,
          durationSeconds: sql`excluded.duration_seconds`,
          contactNumber: sql`excluded.contact_number`,
          contactKey: sql`excluded.contact_key`,
          contactExternalId: sql`excluded.contact_external_id`,
          agentName: sql`excluded.agent_name`,
          /*
           * `source` and `lead_external_id` are deliberately absent.
           *
           * A webhook delivering a call the CSV already imported must not
           * relabel its provenance, and re-importing the export must not undo
           * a lead match the resolve pass has since made. The upsert carries
           * the facts about the call; those two are facts about how it got
           * here and what it has been joined to.
           */
          syncRunId: sql`excluded.sync_run_id`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning({ id: schema.calls.id });
    written += result.length;
  }
  return written;
}

export type LeadMatchResult = {
  /** Calls whose lead changed in this pass. */
  matched: number;
  /** Calls with a usable key that match no lead. */
  unmatched: number;
  /** Calls whose number could not be keyed at all. */
  unkeyed: number;
  /** Phone keys held by more than one lead, and the calls they affect. */
  ambiguousKeys: number;
  ambiguousCalls: number;
};

/**
 * Which lead owns each phone key, and which keys nobody can own.
 *
 * Shared by the full pass and the per-delivery one so the two cannot disagree
 * about what a match is. `only` narrows it to the keys a delivery actually
 * brought; omitted, it reads the tenant's whole book.
 */
async function leadsByPhoneKey(
  tx: Database,
  tenantId: string,
  only?: readonly string[],
): Promise<{ unique: Map<string, string>; ambiguous: Set<string> }> {
  const unique = new Map<string, string>();
  const ambiguous = new Set<string>();
  // `inArray` with nothing in it is invalid SQL, and an empty delivery has
  // nothing to match anyway.
  if (only && only.length === 0) return { unique, ambiguous };

  // One row per phone key: how many leads hold it, and which lead — the second
  // is only meaningful when the first is 1.
  const keyed = await tx
    .select({
      phoneKey: schema.leads.phoneKey,
      leads: sql<number>`count(*)::int`,
      leadExternalId: sql<string>`min(${schema.leads.externalId})`,
    })
    .from(schema.leads)
    .where(
      and(
        eq(schema.leads.tenantId, tenantId),
        isNotNull(schema.leads.phoneKey),
        ...(only ? [inArray(schema.leads.phoneKey, [...only])] : []),
      ),
    )
    .groupBy(schema.leads.phoneKey);

  for (const row of keyed) {
    if (!row.phoneKey) continue;
    if (Number(row.leads) === 1) unique.set(row.phoneKey, row.leadExternalId);
    else ambiguous.add(row.phoneKey);
  }
  return { unique, ambiguous };
}

/** Writes the matches. Returns how many calls actually changed. */
async function applyMatches(
  tx: Database,
  tenantId: string,
  unique: Map<string, string>,
): Promise<number> {
  if (unique.size === 0) return 0;
  let matched = 0;
  // Batched by key rather than by call: 4,415 distinct numbers against
  // 28,863 calls.
  const entries = [...unique];
  const size = 500;
  for (let i = 0; i < entries.length; i += size) {
    const batch = entries.slice(i, i + size);
    const values = sql.join(
      batch.map(([key, lead]) => sql`(${key}, ${lead})`),
      sql`, `,
    );
    const result = await tx.execute(sql`
      update ${schema.calls} as c
         set lead_external_id = m.lead_external_id
        from (values ${values}) as m(contact_key, lead_external_id)
       where c.tenant_id = ${tenantId}
         and c.contact_key = m.contact_key
         and c.lead_external_id is distinct from m.lead_external_id
    `);
    matched += Number((result as unknown as { count?: number }).count ?? 0);
  }
  return matched;
}

/**
 * Joins calls to leads by phone number, across the tenant's whole history.
 *
 * Its own idempotent pass rather than part of the insert, because the two sides
 * arrive independently: a call can land before its lead is synced, and a lead's
 * phone can be corrected after the call. Re-running it is how a match appears
 * later — the same shape as `backfillClickIdsFromConvertedLeads`.
 *
 * **An ambiguous key is left unmatched.** Where two leads share a number — a
 * merchant who filled the form twice, or an office switchboard — nothing says
 * which of them a call belongs to. Picking the newest would produce a
 * speed-to-lead figure that looks measured and is arbitrary, so those calls
 * stay unmatched, are counted, and the count goes on screen.
 *
 * This is the sweep, and it costs a sweep: every lead key grouped, every call
 * considered. A webhook delivery uses `resolveLeadsForDelivery` instead.
 */
export async function resolveCallLeads(
  tx: Database,
  tenantId: string,
): Promise<LeadMatchResult> {
  const { unique, ambiguous } = await leadsByPhoneKey(tx, tenantId);
  const matched = await applyMatches(tx, tenantId, unique);

  const [counts] = await tx
    .select({
      unkeyed: sql<number>`count(*) filter (where ${schema.calls.contactKey} is null)::int`,
      unmatched: sql<number>`count(*) filter (
        where ${schema.calls.contactKey} is not null
          and ${schema.calls.leadExternalId} is null
      )::int`,
    })
    .from(schema.calls)
    .where(eq(schema.calls.tenantId, tenantId));

  let ambiguousCalls = 0;
  if (ambiguous.size > 0) {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.calls)
      .where(
        and(
          eq(schema.calls.tenantId, tenantId),
          isNull(schema.calls.leadExternalId),
          // `inArray`, not `= any(...)`: drizzle binds a JS array as a
          // parameter tuple, which produces `any(($2, $3, …))` — invalid SQL
          // that fails only once there is something in the list.
          inArray(schema.calls.contactKey, [...ambiguous]),
        ),
      );
    ambiguousCalls = Number(row?.n ?? 0);
  }

  return {
    matched,
    unmatched: Number(counts?.unmatched ?? 0),
    unkeyed: Number(counts?.unkeyed ?? 0),
    ambiguousKeys: ambiguous.size,
    ambiguousCalls,
  };
}

/**
 * The same join, for the handful of numbers one webhook delivery brought.
 *
 * Currency is the point of the webhook: a call that waits for the next hourly
 * Salesforce sync to be matched is a call that speed to lead cannot see for up
 * to an hour, and speed to lead is measured on matched calls. But
 * `resolveCallLeads` is a sweep — every lead key grouped, every call in the
 * tenant considered — and running a sweep on each of three to four hundred
 * daily deliveries would rescan the whole history hundreds of times to place
 * one row.
 *
 * So this narrows both halves to the keys that arrived, and shares
 * `leadsByPhoneKey` and `applyMatches` with the sweep so the two paths cannot
 * come to different answers about what a match is. The ambiguity rule is the
 * sweep's, unchanged: a number two leads hold matches neither.
 *
 * It deliberately matches **every** call on those numbers rather than only the
 * ones just written. It is the same bounded index lookup — `calls` is indexed
 * on (tenant, contact_key) — and an earlier call from a merchant who has since
 * been synced as a lead is exactly the row that should heal here.
 */
export type DeliveryMatchResult = {
  /** Calls whose lead changed, which may include earlier ones on the number. */
  matched: number;
  /** Keys in this delivery that no lead holds — usually a lead not yet synced. */
  unmatched: number;
  /** Keys in this delivery held by more than one lead, so matched to none. */
  ambiguous: number;
};

export async function resolveLeadsForDelivery(
  tx: Database,
  tenantId: string,
  contactKeys: readonly string[],
): Promise<DeliveryMatchResult> {
  const keys = [...new Set(contactKeys)];
  if (keys.length === 0) return { matched: 0, unmatched: 0, ambiguous: 0 };

  const { unique, ambiguous } = await leadsByPhoneKey(tx, tenantId, keys);
  const matched = await applyMatches(tx, tenantId, unique);

  return {
    matched,
    unmatched: keys.filter((key) => !unique.has(key) && !ambiguous.has(key)).length,
    ambiguous: keys.filter((key) => ambiguous.has(key)).length,
  };
}
