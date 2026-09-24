import { and, desc, eq, sql } from 'drizzle-orm';
import {
  buildStageHistoryQuery,
  buildSubmissionQuery,
  extractStageHistoryEvents,
  normalizeSubmissions,
  buildIncrementalQuery,
  countLeadClassification,
  extractStageEvents,
  normalizeLead,
  normalizeOpportunity,
  reconcileDeletesAndMerges,
  validateMapping,
  absentFields,
  NO_LEAD_EXCLUSION,
  type ExclusionCounts,
  type LeadExclusionConfig,
  type SalesforceClient,
  type SalesforceFieldMapping,
  type SalesforceRecord,
} from '@zeeraa/connectors';
import { qualifyLead, type LeadSourceRules, type QualificationBar } from '@zeeraa/core';
import { schema, withJobTenant, type Database } from '@zeeraa/db';
import { resolveCallLeads } from '../aloware/writer';
import {
  closeSyncRun,
  lastSuccessfulWatermark,
  openSyncRun,
  recordSourceWindow,
} from '../sync-runs';
import {
  applyReconciliation,
  upsertLeads,
  upsertOpportunities,
  upsertOpportunityClickIds,
  upsertStageEvents,
  upsertSubmissions,
  type ClickIdRow,
} from './writer';
import {
  applyStageCorrections,
  applyStageExclusions,
  applyLeadSourceExclusions,
  applyLenderExclusions,
  type LenderExclusion,
  type StageCorrection,
  type StageExclusionRule,
} from './stage-rules';

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
  /** `lead_source_rules`: which source a lead with no click ID is credited to. */
  leadSources?: LeadSourceRules | null;
  /** Events that are real but not counted — renewals reaching Funded. */
  stageExclusions?: StageExclusionRule[];
  /** Test lenders, from `lender_exclusions`. */
  lenderExclusions?: LenderExclusion | null;
  /** Stage dates a person has corrected over the CRM's. */
  stageCorrections?: StageCorrection[];
};

export type SyncResult = {
  syncRunId: string;
  leads: number;
  opportunities: number;
  stageEvents: number;
  /** Stage events excluded from counting, per configured reason. */
  stageExclusions: Record<string, number>;
  /** Hand-recorded corrections in force after this run. */
  stageCorrections: number;
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
  /**
   * Mapped fields the org does not have, or the integration user cannot read —
   * a describe cannot tell the two apart. Dropped from the query and reported,
   * because a column of nulls is indistinguishable from no data once it lands.
   */
  missingFields: string[];
  /**
   * What `OpportunityFieldHistory` gave up this run.
   *
   * `span` is the retained window actually observed, which is a coverage limit
   * on every stage read from it — history begins when tracking was switched on
   * and nothing before it exists. `unrecognised` is stage labels the alias map
   * has never seen; a new picklist value lands there instead of vanishing.
   */
  stageHistory: {
    rows: number;
    events: number;
    counts: Record<string, number>;
    span: { earliest: Date | null; latest: Date | null };
    unrecognised: Record<string, number>;
  };
  /**
   * Lender submissions, where the client's org has them.
   *
   * `unclassified` is a status value the mapping does not know. Those become
   * `undecided` — never a decision — and are reported here so a new picklist
   * entry shows up as a number rather than as a slow drift in the denominator
   * of the offer rate.
   */
  submissions: {
    rows: number;
    counts: { offered: number; declined: number; undecided: number };
    span: { earliest: Date | null; latest: Date | null };
    unclassified: Record<string, number>;
  } | null;
  /**
   * The call-to-lead join, re-run after the leads are written.
   *
   * Here because leads changing is exactly what invalidates it: a call
   * imported before its lead existed stays unmatched until something resolves
   * it again, and without this that something would have to be a person
   * remembering to re-run the import. Null when the tenant has no calls.
   */
  callLeadMatches: { matched: number; unmatched: number; unkeyed: number } | null;
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
  /**
   * `since` overrides the watermark this run reads from.
   *
   * Left unset, the window starts at the last *succeeded* run, which is the
   * right default for the nightly and for a manual catch-up. The hourly
   * incremental endpoint sets it explicitly, because a tenant whose sync
   * reports `partial` for a permanently absent field would otherwise never
   * advance its watermark and every "incremental" run would be a full pull.
   * See `runIncrementalSync`.
   */
  options: { trigger?: string; now?: Date; since?: Date } = {},
): Promise<SyncResult> {
  const now = options.now ?? new Date();

  return withJobTenant(context.tenantId, async (tx) => {
    const syncRunId = await openSyncRun(tx, context.tenantId, options.trigger ?? 'scheduled', now);
    const result: SyncResult = {
      syncRunId,
      leads: 0,
      opportunities: 0,
      stageEvents: 0,
      stageExclusions: {},
      stageCorrections: 0,
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
      missingFields: [],
      submissions: null,
      callLeadMatches: null,
      stageHistory: {
        rows: 0,
        events: 0,
        counts: {},
        span: { earliest: null, latest: null },
        unrecognised: {},
      },
      status: 'succeeded',
    };

    try {
      // Validate before reading. A mapped field the integration user cannot see
      // returns nothing from the API, which is indistinguishable from "no data"
      // once it is a column of nulls in Postgres.
      const validation = await validateMapping(context.client, context.mapping);
      result.blocked = validation.blocking;
      if (validation.blocking.length > 0) result.status = 'partial';

      // Absent fields are dropped from the SELECT rather than sent and refused.
      // SOQL rejects the whole query for one unknown field, so a mapping naming
      // a field the org never created would otherwise cost every lead, every
      // opportunity and every stage event — not the one slice that field
      // carries. What is missing is already recorded on the run, and
      // `validation.blocking` decides whether it is worth stopping for.
      const omitLead = absentFields(validation, 'Lead');
      const omitOpportunity = absentFields(validation, 'Opportunity');
      result.missingFields = [
        ...omitLead.map((f) => `Lead.${f}`),
        ...omitOpportunity.map((f) => `Opportunity.${f}`),
      ];
      if (result.missingFields.length > 0 && result.status === 'succeeded') {
        result.status = 'partial';
      }

      const since = options.since ?? (await lastSuccessfulWatermark(tx, context.tenantId));
      const exclusion = context.leadExclusion ?? NO_LEAD_EXCLUSION;

      // --- Leads -------------------------------------------------------------
      // Counted before they are read. The out-of-scope records are never
      // fetched — the exclusion is in the WHERE clause below — so this is the
      // only opportunity to know how many there were, and leaving it out would
      // make the exclusion invisible rather than merely effective.
      result.exclusions = await countLeadClassification(context.client, exclusion, since);

      const leadRecords = await context.client.query<SalesforceRecord>(
        buildIncrementalQuery(context.mapping, 'Lead', since, exclusion, omitLead),
      );
      const leads = leadRecords.map((r) =>
        normalizeLead(r, context.mapping, context.clickIdPriority, context.bar, context.leadSources ?? null),
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
        if (lead.mqlVerdict === 'undeterminable') result.qualificationUndetermined += 1;
      }

      // --- Opportunities and stage events ------------------------------------
      const oppRecords = await context.client.query<SalesforceRecord>(
        buildIncrementalQuery(context.mapping, 'Opportunity', since, undefined, omitOpportunity),
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
          // The verdict resolved at ingest from whatever bands the lead
          // carries, not a numeric comparison — the inputs are bands and the
          // numbers are mostly absent. `undeterminable` produces no event:
          // guessing either way moves a headline conversion rate.
          if (lead.mqlVerdict !== 'qualified') continue;
          stageEvents.push({
            opportunityExternalId: opportunityId,
            stage: context.mqlStageKey,
            occurredAt: lead.createdAt,
            origin: 'computed',
          });
        }
      }

      /**
       * Stages whose timestamp field nobody fills in, read from field history.
       *
       * `csbs__Approved_Date_Time__c` is empty on every opportunity in the org,
       * so UW approved had no source through its mapped field. History tracking
       * on `StageName` does hold the transitions, so the stage is observable —
       * just not where the mapping looked. Only stages the alias map elects are
       * emitted, so this cannot double-count a stage that already has a stamped
       * field.
       *
       * Read unbounded, unlike everything else in this sync.
       *
       * Field history is immutable and bounded by retention — about 1,300 rows
       * for this org's whole window, one page, well inside the hourly budget.
       * So the entire window is cheaper to re-read than to keep a second
       * watermark for, and re-reading self-heals any gap a missed run left. The
       * upsert key is (opportunity, stage, occurredAt), so a row that arrives
       * twice is the same row.
       */
      const historyRows = await context.client.query<SalesforceRecord>(
        buildStageHistoryQuery(),
      );
      const history = extractStageHistoryEvents(historyRows);
      result.stageHistory = {
        rows: historyRows.length,
        events: history.events.length,
        counts: history.counts,
        span: history.span,
        unrecognised: history.unrecognised,
      };
      stageEvents.push(...history.events);

      // The horizon travels with the stages read from it. Measured every run,
      // so it rolls forward as retention expires the oldest rows rather than
      // going quietly stale in a constant.
      if (history.span.earliest) {
        await recordSourceWindow(
          tx,
          context.tenantId,
          'salesforce:stage_history',
          'salesforce',
          history.span.earliest,
          syncRunId,
        );
      }

      result.stageEvents = await upsertStageEvents(
        tx,
        context.tenantId,
        stageEvents,
        syncRunId,
      );

      /*
       * Corrections, then exclusions, over the whole table.
       *
       * After the upsert because the upsert writes the CRM's version back
       * whenever a corrected deal is modified. Exclusions last, so a corrected
       * event is judged like any other. Both idempotent; see `stage-rules.ts`.
       */
      result.stageCorrections = await applyStageCorrections(
        tx,
        context.tenantId,
        context.stageCorrections ?? [],
      );
      result.stageExclusions = await applyStageExclusions(
        tx,
        context.tenantId,
        context.stageExclusions ?? [],
      );
      // Straight after: the stage exclusions clear every lead's reason first.
      await applyLeadSourceExclusions(tx, context.tenantId, context.leadExclusion ?? NO_LEAD_EXCLUSION);

      // --- Lender submissions --------------------------------------------------
      /*
       * Read unbounded, for the same reason field history is: the object holds
       * 1,427 rows for this org's entire history and a submission's status
       * changes long after it is created, so an incremental window on
       * `LastModifiedDate` would still have to be generous and a full re-read
       * self-heals anything a missed run left behind. If this object grows past
       * a page or two, bound it — `buildSubmissionQuery` already takes `since`.
       *
       * Absent configuration means the tenant has no lender grain. That is a
       * supported state, not a failure: `submissions` stays null, the funnel
       * renders the blocked dependency, and nothing else in this sync changes.
       */
      if (context.mapping.submissions) {
        const submissionRecords = await context.client.query<SalesforceRecord>(
          buildSubmissionQuery(context.mapping.submissions),
        );
        const submissions = normalizeSubmissions(submissionRecords, context.mapping.submissions);
        const written = await upsertSubmissions(
          tx,
          context.tenantId,
          submissions.rows,
          syncRunId,
        );
        // After the upsert, so a test lender's new submission is excluded in
        // the same run it arrives.
        await applyLenderExclusions(tx, context.tenantId, context.lenderExclusions ?? null);
        result.submissions = {
          rows: written,
          counts: submissions.counts,
          span: submissions.span,
          unclassified: submissions.unclassified,
        };

        // The object begins in June 2026, so every submission metric has a
        // horizon of its own — earlier periods hold no submissions rather than
        // no lender activity.
        if (submissions.span.earliest) {
          await recordSourceWindow(
            tx,
            context.tenantId,
            'salesforce:submissions',
            'salesforce',
            submissions.span.earliest,
            syncRunId,
          );
        }
      }

      /*
       * Re-resolve the call-to-lead join now that leads are current.
       *
       * Idempotent, and cheap: one grouped read over phone keys plus a batched
       * update per 500 keys. Skipped entirely where the tenant has no calls,
       * so a client without call tracking pays nothing for it.
       */
      const [callRow] = await tx
        .select({ calls: sql<number>`count(*)::int` })
        .from(schema.calls)
        .where(eq(schema.calls.tenantId, context.tenantId));
      if (Number(callRow?.calls ?? 0) > 0) {
        const match = await resolveCallLeads(tx, context.tenantId);
        result.callLeadMatches = {
          matched: match.matched,
          unmatched: match.unmatched,
          unkeyed: match.unkeyed,
        };
      }

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

      /**
       * Why this run was not `succeeded`, recorded rather than discarded.
       *
       * `missingFields` and `blocked` were computed and then thrown away, so
       * the only explanation for a `partial` run lived in the console output of
       * whoever ran it. The connection panel had nothing to read and invented
       * "Connection unavailable" — which is false: the connection works, one
       * mapped field does not exist in the org. The reason belongs on the run,
       * where it is per-run, self-correcting, and visible without a redeploy.
       */
      const shortfall =
        result.status === 'succeeded'
          ? null
          : [
              result.blocked.length > 0
                ? `Blocking mapping problems: ${result.blocked.join('; ')}.`
                : null,
              result.missingFields.length > 0
                ? `Synced, with ${result.missingFields.length} mapped ${
                    result.missingFields.length === 1 ? 'field' : 'fields'
                  } absent from the org and dropped from the query: ${result.missingFields.join(', ')}.`
                : null,
            ]
              .filter(Boolean)
              .join(' ') || null;

      await closeSyncRun(
        tx,
        syncRunId,
        result.status,
        totalRows(result),
        shortfall,
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

export {
  openSyncRun,
  closeSyncRun,
  lastSuccessfulWatermark,
} from '../sync-runs';
