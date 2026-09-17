import { and, desc, eq } from 'drizzle-orm';
import {
  buildIncrementalQuery,
  countLeadClassification,
  extractStageEvents,
  normalizeLead,
  normalizeOpportunity,
  reconcileDeletesAndMerges,
  validateMapping,
  NO_LEAD_EXCLUSION,
  type ExclusionCounts,
  type LeadExclusionConfig,
  type SalesforceClient,
  type SalesforceFieldMapping,
  type SalesforceRecord,
} from '@zeeraa/connectors';
import { qualifyLead, type QualificationBar } from '@zeeraa/core';
import { schema, withJobTenant, type Database } from '@zeeraa/db';
import {
  applyReconciliation,
  upsertLeads,
  upsertOpportunities,
  upsertOpportunityClickIds,
  upsertStageEvents,
  type ClickIdRow,
} from './writer';

export type SyncContext = {
  tenantId: string;
  connectionId: string;
  client: SalesforceClient;
  mapping: SalesforceFieldMapping;
  bar: QualificationBar;
  clickIdPriority: readonly string[];
  /**
   * Which Lead records this platform may ingest. Applied in the SOQL WHERE
   * clause, so an out-of-scope record is never read.
   */
  leadExclusion?: LeadExclusionConfig;
  /** Which funnel stage MQL corresponds to, if any. */
  mqlStageKey?: string;
};

export type SyncResult = {
  syncRunId: string;
  leads: number;
  opportunities: number;
  stageEvents: number;
  clickIds: number;
  deleted: number;
  merged: number;
  /** Leads whose monthly and annual revenue figures disagree beyond tolerance. */
  revenueDisagreements: number;
  /** Leads where the MQL bar could not be evaluated at all. */
  qualificationUndetermined: number;
  /**
   * What this run refused to ingest, per rule, plus the unclassified residue.
   * Written to the sync run so the exclusion is auditable rather than an
   * invisible narrowing of the denominator.
   */
  exclusions: ExclusionCounts;
  blocked: string[];
  status: 'succeeded' | 'partial' | 'failed';
};

/**
 * The incremental Salesforce sync.
 *
 * Runs inside `withJobTenant`, so the tenant is established by the database
 * rather than by a filter in every query. A bug here corrupts one client's
 * numbers; it cannot reach a second client's.
 *
 * The window starts from the last successful run rather than from a fixed
 * interval, so a sync that was down for a day catches up rather than leaving a
 * hole. Deletions are the exception — `getDeleted` only reaches back about 30
 * days, which bounds how long the sync may be broken before deletions are lost
 * for good, and that limit is reported rather than hidden.
 */
export async function runSalesforceSync(
  context: SyncContext,
  options: { trigger?: string; now?: Date } = {},
): Promise<SyncResult> {
  const now = options.now ?? new Date();

  return withJobTenant(context.tenantId, async (tx) => {
    const syncRunId = await openSyncRun(tx, context.tenantId, options.trigger ?? 'scheduled', now);
    const result: SyncResult = {
      syncRunId,
      leads: 0,
      opportunities: 0,
      stageEvents: 0,
      clickIds: 0,
      deleted: 0,
      merged: 0,
      revenueDisagreements: 0,
      qualificationUndetermined: 0,
      exclusions: {
        considered: 0,
        excludedTotal: 0,
        perRule: [],
        unclassified: 0,
        inbound: 0,
        rulesOverlap: false,
      },
      blocked: [],
      status: 'succeeded',
    };

    try {
      // Validate before reading. A mapped field the integration user cannot see
      // returns nothing from the API, which is indistinguishable from "no data"
      // once it is a column of nulls in Postgres.
      const validation = await validateMapping(context.client, context.mapping);
      result.blocked = validation.blocking;
      if (validation.blocking.length > 0) result.status = 'partial';

      const since = await lastSuccessfulWatermark(tx, context.tenantId);
      const exclusion = context.leadExclusion ?? NO_LEAD_EXCLUSION;

      // --- Leads -------------------------------------------------------------
      // Counted before they are read. The out-of-scope records are never
      // fetched — the exclusion is in the WHERE clause below — so this is the
      // only opportunity to know how many there were, and leaving it out would
      // make the exclusion invisible rather than merely effective.
      result.exclusions = await countLeadClassification(context.client, exclusion, since);

      const leadRecords = await context.client.query<SalesforceRecord>(
        buildIncrementalQuery(context.mapping, 'Lead', since, exclusion),
      );
      const leads = leadRecords.map((r) =>
        normalizeLead(r, context.mapping, context.clickIdPriority),
      );
      result.leads = await upsertLeads(tx, context.tenantId, leads, syncRunId, context.bar);

      for (const lead of leads) {
        const q = qualifyLead(
          {
            revenue: {
              monthly: lead.selfReportedRevenue,
              annual: lead.selfReportedAnnualRevenue,
            },
            timeInBusinessMonths: lead.selfReportedTimeInBusiness,
          },
          context.bar,
        );
        if (q.revenueDisagreement) result.revenueDisagreements += 1;
        if (q.qualified === null) result.qualificationUndetermined += 1;
      }

      // --- Opportunities and stage events ------------------------------------
      const oppRecords = await context.client.query<SalesforceRecord>(
        buildIncrementalQuery(context.mapping, 'Opportunity', since),
      );

      const leadByOpportunity = new Map(
        leads
          .filter((l) => l.convertedOpportunityId)
          .map((l) => [l.convertedOpportunityId!, l] as const),
      );

      const opportunities = oppRecords.map((r) =>
        normalizeOpportunity(
          r,
          context.mapping,
          leadByOpportunity.get(String(r.Id))?.externalId ?? null,
        ),
      );
      result.opportunities = await upsertOpportunities(
        tx,
        context.tenantId,
        opportunities,
        syncRunId,
      );

      const stageEvents = oppRecords.flatMap((r) => extractStageEvents(r, context.mapping));

      // MQL has no timestamp field in Salesforce. It is derived from the
      // qualification bar — both attributes are known at lead creation — and
      // marked computed so nothing downstream can present it as observed.
      if (context.mqlStageKey) {
        for (const [opportunityId, lead] of leadByOpportunity) {
          const q = qualifyLead(
            {
              revenue: {
                monthly: lead.selfReportedRevenue,
                annual: lead.selfReportedAnnualRevenue,
              },
              timeInBusinessMonths: lead.selfReportedTimeInBusiness,
            },
            context.bar,
          );
          if (q.qualified !== true) continue;
          stageEvents.push({
            opportunityExternalId: opportunityId,
            stage: context.mqlStageKey,
            occurredAt: lead.createdAt,
            origin: 'computed',
          });
        }
      }

      result.stageEvents = await upsertStageEvents(
        tx,
        context.tenantId,
        stageEvents,
        syncRunId,
      );

      // --- Click IDs from the mapped Opportunity fields -----------------------
      const clickIdRows: ClickIdRow[] = [];
      for (const record of oppRecords) {
        for (const [platform, field] of Object.entries(context.mapping.opportunity.clickIds)) {
          const value = record[field];
          if (value == null || String(value).trim() === '') continue;
          clickIdRows.push({
            opportunityExternalId: String(record.Id),
            platform,
            clickId: String(value).trim(),
            source: 'opportunity_field',
          });
        }
      }
      result.clickIds = await upsertOpportunityClickIds(
        tx,
        context.tenantId,
        clickIdRows,
        syncRunId,
      );

      // --- What SystemModstamp cannot see ------------------------------------
      const deletionWindowStart = since ?? new Date(now.getTime() - 29 * 86_400_000);
      for (const object of ['Lead', 'Opportunity'] as const) {
        const reconciliation = await reconcileDeletesAndMerges(
          context.client,
          object,
          deletionWindowStart,
          now,
        );
        const counts = await applyReconciliation(
          tx,
          context.tenantId,
          object,
          reconciliation,
        );
        result.deleted += counts.deleted;
        result.merged += counts.merged;
      }

      await closeSyncRun(
        tx,
        syncRunId,
        result.status,
        totalRows(result),
        null,
        result.exclusions,
      );
      return result;
    } catch (error) {
      await closeSyncRun(
        tx,
        syncRunId,
        'failed',
        totalRows(result),
        String(error),
        result.exclusions,
      );
      throw error;
    }
  });
}

function totalRows(result: SyncResult): number {
  return result.leads + result.opportunities + result.stageEvents + result.clickIds;
}

export async function openSyncRun(
  tx: Database,
  tenantId: string,
  trigger: string,
  startedAt: Date,
): Promise<string> {
  const [row] = await tx
    .insert(schema.syncRuns)
    .values({ tenantId, platform: 'salesforce', trigger, startedAt, status: 'running' })
    .returning({ id: schema.syncRuns.id });
  return row!.id;
}

export async function closeSyncRun(
  tx: Database,
  syncRunId: string,
  status: 'succeeded' | 'partial' | 'failed',
  rowsWritten: number,
  error: string | null,
  exclusions?: ExclusionCounts,
): Promise<void> {
  await tx
    .update(schema.syncRuns)
    .set({
      finishedAt: new Date(),
      status,
      rowsWritten: String(rowsWritten),
      error,
      // Written on a failed run too. A run that died halfway still refused
      // records before it died, and the count is the evidence for what the
      // partial numbers mean.
      ...(exclusions ? { exclusions } : {}),
    })
    .where(eq(schema.syncRuns.id, syncRunId));
}

/**
 * The high-water mark: the start of the last run that actually finished.
 *
 * Deliberately the *started* time of that run, not its finished time. A record
 * modified while a sync was in flight would otherwise fall into the gap between
 * the two and never be picked up.
 */
export async function lastSuccessfulWatermark(
  tx: Database,
  tenantId: string,
): Promise<Date | null> {
  const [row] = await tx
    .select({ startedAt: schema.syncRuns.startedAt })
    .from(schema.syncRuns)
    .where(
      and(
        eq(schema.syncRuns.tenantId, tenantId),
        eq(schema.syncRuns.platform, 'salesforce'),
        eq(schema.syncRuns.status, 'succeeded'),
      ),
    )
    .orderBy(desc(schema.syncRuns.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}
