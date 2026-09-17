import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@zeeraa/db";
import { schema } from "@zeeraa/db";
import { normalizeMonthlyRevenue, type QualificationBar } from "@zeeraa/core";
import type {
  LeadRow,
  OpportunityRow,
  Reconciliation,
  StageEventRow,
} from "@zeeraa/connectors";

/**
 * Writing CRM records into Postgres.
 *
 * Everything here upserts. A sync re-reads a trailing window on every run
 * because CRM records change stage retroactively, so an append would multiply
 * every restatement — the same reason `daily_metrics` is upsert-only (§16).
 *
 * Every function takes the transaction handle from `withJobTenant`, so the
 * tenant is already established by the database rather than by a `where` clause
 * somebody has to remember.
 */

export type WriteCounts = { inserted: number; updated: number };

/**
 * Rows per INSERT.
 *
 * A full-history sync hands these writers every record the org has, and one
 * statement per sync is two distinct failures at that size. Postgres binds at
 * most 65,535 parameters per statement, so a wide table tops out in the low
 * thousands of rows; and drizzle builds the statement by spreading each row's
 * parameters into an accumulator, which overflows the call stack before
 * Postgres is ever asked.
 *
 * Both limits scale with the column count, so the budget is expressed in
 * parameters and the batch size falls out of it. Deliberately well under the
 * ceiling: `on conflict do update` doubles nothing, but a nullable column added
 * later should not silently walk a batch back over the line.
 */
const PARAMETER_BUDGET = 40_000;

function batchSize(columns: number): number {
  return Math.max(1, Math.floor(PARAMETER_BUDGET / columns));
}

/**
 * Runs `write` over `rows` in batches and sums what came back.
 *
 * Sequential rather than concurrent: these all run inside one `withJobTenant`
 * transaction, and a transaction is a single connection — issuing the batches
 * in parallel would interleave them on the one backend rather than speed
 * anything up.
 */
async function inBatches<T>(
  rows: readonly T[],
  size: number,
  write: (batch: readonly T[]) => Promise<number>,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < rows.length; i += size) {
    total += await write(rows.slice(i, i + size));
  }
  return total;
}

/**
 * Collapses rows that share an upsert key.
 *
 * Postgres refuses an `on conflict do update` that would touch the same row
 * twice within one statement, and a CRM supplies duplicate keys as a matter of
 * course — two converted leads pointing at the same opportunity, the same stage
 * timestamp read twice. Last one wins, which matches the upsert's own semantics
 * had the rows arrived in separate statements.
 */
function byUpsertKey<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) seen.set(key(row), row);
  return [...seen.values()];
}

export async function upsertLeads(
  tx: Database,
  tenantId: string,
  rows: readonly LeadRow[],
  syncRunId: string,
  bar?: QualificationBar,
): Promise<number> {
  if (rows.length === 0) return 0;

  const deduped = byUpsertKey(rows, (row) => row.externalId);

  return inBatches(deduped, batchSize(21), async (batch) => {
    const written = await tx
      .insert(schema.leads)
      .values(
        batch.map((row) => ({
          tenantId,
          externalId: row.externalId,
          createdAt: row.createdAt,
          clickId: row.clickId,
          clickIdType: row.clickIdType,
          utmSource: row.utmSource,
          utmMedium: row.utmMedium,
          utmCampaign: row.utmCampaign,
          utmContent: row.utmContent,
          utmTerm: row.utmTerm,
          landingPage: row.landingPage,
          selfReportedRevenue: row.selfReportedRevenue?.toFixed(2) ?? null,
          selfReportedAnnualRevenue:
            row.selfReportedAnnualRevenue?.toFixed(2) ?? null,
          selfReportedTimeInBusiness:
            row.selfReportedTimeInBusiness?.toFixed(2) ?? null,
          revenueFiguresDisagree: bar
            ? normalizeMonthlyRevenue(
                {
                  monthly: row.selfReportedRevenue,
                  annual: row.selfReportedAnnualRevenue,
                },
                bar.revenueDisagreementTolerance,
              ).disagreement
            : false,
          industry: row.industry,
          state: row.state,
          convertedOpportunityId: row.convertedOpportunityId,
          mergedInto: row.mergedInto,
          syncRunId,
          updatedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: [schema.leads.tenantId, schema.leads.externalId],
        set: {
          clickId: sql`excluded.click_id`,
          clickIdType: sql`excluded.click_id_type`,
          utmSource: sql`excluded.utm_source`,
          utmMedium: sql`excluded.utm_medium`,
          utmCampaign: sql`excluded.utm_campaign`,
          utmContent: sql`excluded.utm_content`,
          utmTerm: sql`excluded.utm_term`,
          landingPage: sql`excluded.landing_page`,
          selfReportedRevenue: sql`excluded.self_reported_revenue`,
          selfReportedAnnualRevenue: sql`excluded.self_reported_annual_revenue`,
          selfReportedTimeInBusiness: sql`excluded.self_reported_time_in_business`,
          revenueFiguresDisagree: sql`excluded.revenue_figures_disagree`,
          industry: sql`excluded.industry`,
          state: sql`excluded.state`,
          convertedOpportunityId: sql`excluded.converted_opportunity_id`,
          mergedInto: sql`excluded.merged_into`,
          syncRunId: sql`excluded.sync_run_id`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning({ id: schema.leads.id });

    return written.length;
  });
}

export async function upsertOpportunities(
  tx: Database,
  tenantId: string,
  rows: readonly OpportunityRow[],
  syncRunId: string,
): Promise<number> {
  if (rows.length === 0) return 0;

  const deduped = byUpsertKey(rows, (row) => row.externalId);

  return inBatches(deduped, batchSize(12), async (batch) => {
    const written = await tx
      .insert(schema.opportunities)
      .values(
        batch.map((row) => ({
          tenantId,
          externalId: row.externalId,
          leadExternalId: row.leadExternalId,
          createdAt: row.createdAt,
          currentStage: row.currentStage,
          amount: row.amount?.toFixed(2) ?? null,
          fundedAmount: row.fundedAmount?.toFixed(2) ?? null,
          declineReason: row.declineReason,
          industry: row.industry,
          state: row.state,
          syncRunId,
          updatedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: [
          schema.opportunities.tenantId,
          schema.opportunities.externalId,
        ],
        set: {
          // `leadExternalId` is coalesced rather than overwritten: the opportunity
          // query does not know which lead converted into it, so a plain
          // assignment would blank the link the lead sync established.
          leadExternalId: sql`coalesce(excluded.lead_external_id, ${schema.opportunities.leadExternalId})`,
          currentStage: sql`excluded.current_stage`,
          amount: sql`excluded.amount`,
          fundedAmount: sql`excluded.funded_amount`,
          declineReason: sql`excluded.decline_reason`,
          industry: sql`excluded.industry`,
          state: sql`excluded.state`,
          syncRunId: sql`excluded.sync_run_id`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning({ id: schema.opportunities.id });

    return written.length;
  });
}

/**
 * Stage events are keyed by (opportunity, stage, instant), so re-reading the
 * same record writes nothing new. A corrected timestamp in the CRM produces a
 * new row rather than overwriting the old one, which is the honest outcome:
 * the funnel takes the earliest occurrence, and the correction is visible.
 */
export async function upsertStageEvents(
  tx: Database,
  tenantId: string,
  rows: readonly StageEventRow[],
  syncRunId: string,
): Promise<number> {
  if (rows.length === 0) return 0;

  const deduped = byUpsertKey(
    rows,
    (row) =>
      `${row.opportunityExternalId}|${row.stage}|${row.occurredAt.toISOString()}`,
  );

  return inBatches(deduped, batchSize(6), async (batch) => {
    const written = await tx
      .insert(schema.stageEvents)
      .values(
        batch.map((row) => ({
          tenantId,
          opportunityExternalId: row.opportunityExternalId,
          stage: row.stage,
          occurredAt: row.occurredAt,
          origin: row.origin,
          syncRunId,
        })),
      )
      .onConflictDoUpdate({
        target: [
          schema.stageEvents.tenantId,
          schema.stageEvents.opportunityExternalId,
          schema.stageEvents.stage,
          schema.stageEvents.occurredAt,
        ],
        set: {
          origin: sql`excluded.origin`,
          syncRunId: sql`excluded.sync_run_id`,
        },
      })
      .returning({ id: schema.stageEvents.id });

    return written.length;
  });
}

export type ClickIdRow = {
  opportunityExternalId: string;
  platform: string;
  clickId: string;
  source: "opportunity_field" | "lead_conversion";
  leadExternalId?: string | null;
};

export async function upsertOpportunityClickIds(
  tx: Database,
  tenantId: string,
  rows: readonly ClickIdRow[],
  syncRunId: string,
): Promise<number> {
  if (rows.length === 0) return 0;

  // Two converted leads can point at one opportunity — a genuine duplicate in
  // the CRM, not a bug here — and they collide on (opportunity, platform,
  // source).
  const deduped = byUpsertKey(
    rows,
    (row) => `${row.opportunityExternalId}|${row.platform}|${row.source}`,
  );

  return inBatches(deduped, batchSize(8), async (batch) => {
    const written = await tx
      .insert(schema.opportunityClickIds)
      .values(
        batch.map((row) => ({
          tenantId,
          opportunityExternalId: row.opportunityExternalId,
          platform: row.platform,
          clickId: row.clickId,
          source: row.source,
          leadExternalId: row.leadExternalId ?? null,
          syncRunId,
          recordedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: [
          schema.opportunityClickIds.tenantId,
          schema.opportunityClickIds.opportunityExternalId,
          schema.opportunityClickIds.platform,
          schema.opportunityClickIds.source,
        ],
        set: {
          clickId: sql`excluded.click_id`,
          leadExternalId: sql`excluded.lead_external_id`,
          syncRunId: sql`excluded.sync_run_id`,
          recordedAt: sql`excluded.recorded_at`,
        },
      })
      .returning({ id: schema.opportunityClickIds.id });

    return written.length;
  });
}

export type ReconciliationCounts = {
  deleted: number;
  merged: number;
  clickIdsMoved: number;
};

/**
 * Applies what `SystemModstamp` could not see.
 *
 * Deletions remove the local row. Merges do not: a merged record's history
 * moved to the survivor rather than ending, so the loser is marked and any
 * click ID it held is carried across when the survivor has none. Deleting it
 * instead would quietly lose the click that produced the deal — the exact
 * failure this whole layer exists to prevent.
 */
export async function applyReconciliation(
  tx: Database,
  tenantId: string,
  object: "Lead" | "Opportunity",
  reconciliation: Reconciliation,
): Promise<ReconciliationCounts> {
  let deleted = 0;
  let merged = 0;
  let clickIdsMoved = 0;

  if (reconciliation.deletedIds.length > 0) {
    const removed =
      object === "Lead"
        ? await tx
            .delete(schema.leads)
            .where(
              and(
                eq(schema.leads.tenantId, tenantId),
                inArray(schema.leads.externalId, reconciliation.deletedIds),
              ),
            )
            .returning({ id: schema.leads.id })
        : await tx
            .delete(schema.opportunities)
            .where(
              and(
                eq(schema.opportunities.tenantId, tenantId),
                inArray(
                  schema.opportunities.externalId,
                  reconciliation.deletedIds,
                ),
              ),
            )
            .returning({ id: schema.opportunities.id });
    deleted = removed.length;
  }

  for (const { loserId, survivorId } of reconciliation.merges) {
    if (object !== "Lead") {
      merged += 1;
      continue;
    }

    const [loser] = await tx
      .select()
      .from(schema.leads)
      .where(
        and(
          eq(schema.leads.tenantId, tenantId),
          eq(schema.leads.externalId, loserId),
        ),
      );

    await tx
      .update(schema.leads)
      .set({ mergedInto: survivorId, updatedAt: new Date() })
      .where(
        and(
          eq(schema.leads.tenantId, tenantId),
          eq(schema.leads.externalId, loserId),
        ),
      );
    merged += 1;

    if (!loser?.clickId) continue;

    const moved = await tx
      .update(schema.leads)
      .set({
        clickId: loser.clickId,
        clickIdType: loser.clickIdType,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.leads.tenantId, tenantId),
          eq(schema.leads.externalId, survivorId),
          sql`${schema.leads.clickId} is null`,
        ),
      )
      .returning({ id: schema.leads.id });
    clickIdsMoved += moved.length;
  }

  return { deleted, merged, clickIdsMoved };
}
