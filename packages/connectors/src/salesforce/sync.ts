import { qualifyLead, type QualificationMinimums } from '@zeeraa/core';
import type { SalesforceClient } from './client';
import { selectFields, type SalesforceFieldMapping } from './mapping';

/**
 * Turning Salesforce records into rows.
 *
 * Every function here is a pure transform over a record, so the decisions that
 * matter — which click ID wins, how a merged record is handled, when a stage
 * counts as reached — are testable without an org.
 */

export type SalesforceRecord = Record<string, unknown>;

export type LeadRow = {
  externalId: string;
  createdAt: Date;
  clickId: string | null;
  clickIdType: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  landingPage: string | null;
  selfReportedRevenue: number | null;
  selfReportedTimeInBusiness: number | null;
  industry: string | null;
  state: string | null;
  isConverted: boolean;
  convertedOpportunityId: string | null;
  /** Non-null when this lead was merged away into another. */
  mergedInto: string | null;
};

export type OpportunityRow = {
  externalId: string;
  leadExternalId: string | null;
  createdAt: Date;
  currentStage: string;
  amount: number | null;
  fundedAmount: number | null;
  declineReason: string | null;
  industry: string | null;
  state: string | null;
};

export type StageEventRow = {
  opportunityExternalId: string;
  stage: string;
  occurredAt: Date;
  origin: 'observed' | 'computed';
};

function str(record: SalesforceRecord, field?: string): string | null {
  if (!field) return null;
  const value = record[field];
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function num(record: SalesforceRecord, field?: string): number | null {
  if (!field) return null;
  const value = record[field];
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function date(record: SalesforceRecord, field?: string): Date | null {
  const value = str(record, field);
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Picks the click ID to attribute by.
 *
 * A lead can arrive carrying more than one — somebody clicks a Google ad, comes
 * back through a Microsoft ad, and the form posts both. `platformPriority`
 * decides, deterministically, rather than whichever key the object happened to
 * enumerate first. The full set is kept separately so first-touch and
 * last-touch can both be built later.
 */
export function pickClickId(
  record: SalesforceRecord,
  clickIdFields: Record<string, string>,
  platformPriority: readonly string[],
): { clickId: string | null; clickIdType: string | null; all: Record<string, string> } {
  const all: Record<string, string> = {};
  for (const [platform, field] of Object.entries(clickIdFields)) {
    const value = str(record, field);
    if (value) all[platform] = value;
  }

  for (const platform of platformPriority) {
    if (all[platform]) return { clickId: all[platform]!, clickIdType: platform, all };
  }
  const [platform, value] = Object.entries(all)[0] ?? [];
  return { clickId: value ?? null, clickIdType: platform ?? null, all };
}

export const DEFAULT_PLATFORM_PRIORITY = [
  'google_ads',
  'microsoft_ads',
  'meta',
  'linkedin_ads',
] as const;

export function normalizeLead(
  record: SalesforceRecord,
  mapping: SalesforceFieldMapping,
  platformPriority: readonly string[] = DEFAULT_PLATFORM_PRIORITY,
): LeadRow {
  const { clickId, clickIdType } = pickClickId(record, mapping.lead.clickIds, platformPriority);
  return {
    externalId: String(record.Id),
    createdAt: date(record, 'CreatedDate') ?? new Date(0),
    clickId,
    clickIdType,
    utmSource: str(record, mapping.lead.utmSource),
    utmMedium: str(record, mapping.lead.utmMedium),
    utmCampaign: str(record, mapping.lead.utmCampaign),
    utmContent: str(record, mapping.lead.utmContent),
    utmTerm: str(record, mapping.lead.utmTerm),
    landingPage: str(record, mapping.lead.landingPage),
    selfReportedRevenue: num(record, mapping.lead.selfReportedRevenue),
    selfReportedTimeInBusiness: num(record, mapping.lead.selfReportedTimeInBusinessMonths),
    industry: str(record, mapping.lead.industry),
    state: str(record, mapping.lead.state),
    isConverted: record.IsConverted === true,
    convertedOpportunityId: str(record, 'ConvertedOpportunityId'),
    mergedInto: str(record, 'MasterRecordId'),
  };
}

export function normalizeOpportunity(
  record: SalesforceRecord,
  mapping: SalesforceFieldMapping,
  leadExternalId: string | null = null,
): OpportunityRow {
  return {
    externalId: String(record.Id),
    leadExternalId,
    createdAt: date(record, 'CreatedDate') ?? new Date(0),
    currentStage: str(record, 'StageName') ?? 'unknown',
    amount: num(record, mapping.opportunity.amount),
    fundedAmount: num(record, mapping.opportunity.fundedAmount),
    declineReason: str(record, mapping.opportunity.declineReason),
    industry: str(record, mapping.opportunity.industry),
    state: str(record, mapping.opportunity.state),
  };
}

/**
 * Stage events from the explicit datetime fields.
 *
 * A populated field means the stage was reached, whatever the current stage
 * says. That matters: an opportunity sitting at Declined still passed through
 * underwriting, and a funnel built from `StageName` alone would lose every deal
 * that moved on — which is most of them.
 */
export function extractStageEvents(
  record: SalesforceRecord,
  mapping: SalesforceFieldMapping,
): StageEventRow[] {
  const externalId = String(record.Id);
  const events: StageEventRow[] = [];

  for (const [stage, field] of Object.entries(mapping.stages)) {
    const occurredAt = date(record, field);
    if (occurredAt) events.push({ opportunityExternalId: externalId, stage, occurredAt, origin: 'observed' });
  }

  for (const [stage, field] of Object.entries(mapping.extraStageEvents)) {
    const occurredAt = date(record, field);
    if (occurredAt) events.push({ opportunityExternalId: externalId, stage, occurredAt, origin: 'observed' });
  }

  for (const [stage, rule] of Object.entries(mapping.derivedStages)) {
    if (rule !== 'opportunity_created') continue;
    const occurredAt = date(record, 'CreatedDate');
    if (occurredAt) events.push({ opportunityExternalId: externalId, stage, occurredAt, origin: 'computed' });
  }

  return events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

/**
 * The MQL event, derived rather than observed.
 *
 * Salesforce has no MQL timestamp, and for this tenant MQL is defined as a lead
 * meeting the configured minimums — facts known when the lead was created. So
 * the event is the lead's creation time, for leads that qualify, marked
 * `computed` so nothing downstream can present it as something the CRM recorded.
 *
 * A lead whose qualification cannot be determined produces no event. Guessing
 * either way would move a headline conversion rate.
 */
export function deriveQualificationStageEvent(
  lead: LeadRow,
  opportunityExternalId: string,
  stage: string,
  minimums: QualificationMinimums,
): StageEventRow | null {
  const result = qualifyLead(
    {
      selfReportedRevenue: lead.selfReportedRevenue,
      selfReportedTimeInBusinessMonths: lead.selfReportedTimeInBusiness,
    },
    minimums,
  );
  if (result.qualified !== true) return null;
  return { opportunityExternalId, stage, occurredAt: lead.createdAt, origin: 'computed' };
}

export function buildIncrementalQuery(
  mapping: SalesforceFieldMapping,
  object: 'Lead' | 'Opportunity',
  since: Date | null,
): string {
  const fields = selectFields(mapping, object).join(', ');
  const where = since ? ` WHERE SystemModstamp > ${since.toISOString()}` : '';
  return `SELECT ${fields} FROM ${object}${where} ORDER BY SystemModstamp ASC`;
}

export type Reconciliation = {
  /** Hard-deleted; remove the local row. */
  deletedIds: string[];
  /**
   * Merged away. The row must not simply be deleted: the record's history moved
   * to the survivor, and any attribution held against the loser belongs there
   * too. Dropping it would quietly lose the click that produced the deal.
   */
  merges: { loserId: string; survivorId: string }[];
};

/**
 * Finds what `SystemModstamp` cannot see.
 *
 * An incremental pull keyed on a modification timestamp is blind to deletion —
 * the row is simply absent from the next page, and the stale copy lives on
 * locally forever. A merge is worse, because it looks exactly like a deletion
 * while being the opposite: nothing was removed, two records became one.
 */
export async function reconcileDeletesAndMerges(
  client: SalesforceClient,
  object: 'Lead' | 'Opportunity',
  since: Date,
  until: Date = new Date(),
): Promise<Reconciliation> {
  const deleted = await client.getDeleted(object, since, until);
  const deletedIds = deleted.deletedRecords.map((r) => r.id);

  if (deletedIds.length === 0) return { deletedIds: [], merges: [] };

  // Merged losers keep a row, soft-deleted, pointing at the survivor. Only
  // queryAll can see them, and every merge also shows up in getDeleted — so the
  // deletions have to be filtered against this, or a merge is processed twice.
  const ids = deletedIds.map((id) => `'${id}'`).join(',');
  const merged = await client.query<{ Id: string; MasterRecordId: string | null }>(
    `SELECT Id, MasterRecordId FROM ${object} WHERE Id IN (${ids}) AND MasterRecordId != null`,
    true,
  );

  const merges = merged
    .filter((row) => row.MasterRecordId)
    .map((row) => ({ loserId: row.Id, survivorId: row.MasterRecordId! }));
  const mergedIds = new Set(merges.map((m) => m.loserId));

  return { deletedIds: deletedIds.filter((id) => !mergedIds.has(id)), merges };
}
