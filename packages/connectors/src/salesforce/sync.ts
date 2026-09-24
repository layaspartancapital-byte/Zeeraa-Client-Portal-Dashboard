import { qualifyLead, readPhone, type QualificationBar } from '@zeeraa/core';
import type { SalesforceClient } from './client';
import { selectFields, type SalesforceFieldMapping } from './mapping';
import { judgeQualificationBands, readRevenueBand } from './qualification-bands';
import { inboundClause, NO_LEAD_EXCLUSION, type LeadExclusionConfig } from './exclusion';

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
  selfReportedAnnualRevenue: number | null;
  selfReportedTimeInBusiness: number | null;
  industry: string | null;
  state: string | null;
  /** The merged revenue band, as `readRevenueBand` stores it. */
  revenueBand: string | null;
  /** As the CRM holds it, and as ten digits. Null when nothing keys. */
  phone: string | null;
  phoneKey: string | null;
  isConverted: boolean;
  convertedOpportunityId: string | null;
  /** Non-null when this lead was merged away into another. */
  mergedInto: string | null;
  /**
   * The qualification bar's verdict, resolved from whatever bands the lead
   * carries. Null when no bar was supplied to the normaliser.
   */
  mqlVerdict: 'qualified' | 'unqualified' | 'undeterminable' | null;
  /** Why the verdict is `undeterminable`. Null otherwise. */
  mqlUndeterminableReason: string | null;
};

export type OpportunityRow = {
  externalId: string;
  leadExternalId: string | null;
  createdAt: Date;
  currentStage: string;
  amount: number | null;
  fundedAmount: number | null;
  dealType: string | null;
  declineReason: string | null;
  industry: string | null;
  state: string | null;
};

export type StageEventRow = {
  opportunityExternalId: string;
  stage: string;
  occurredAt: Date;
  /**
   * `corrected` is a date a person recorded over what the CRM holds — see
   * `stage_corrections`. Neither observed nor computed, and rendered as such.
   */
  origin: 'observed' | 'computed' | 'corrected';
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

/**
 * The first phone field that yields a join key.
 *
 * Ordered candidates, and the *first that keys* wins rather than the first
 * that is populated: a lead whose `Phone` holds a switchboard with an
 * extension and whose `MobilePhone` holds a real mobile should join on the
 * mobile. `phone` keeps the raw text of whichever field was chosen, so an
 * unjoinable number can still be investigated; when nothing keys, the first
 * populated field is kept as evidence of what was there.
 */
function readLeadPhone(
  record: SalesforceRecord,
  mapping: SalesforceFieldMapping,
): { phone: string | null; phoneKey: string | null } {
  let firstPopulated: string | null = null;
  for (const field of mapping.lead.phones ?? []) {
    const raw = str(record, field);
    if (raw === null) continue;
    firstPopulated ??= raw;
    const reading = readPhone(raw);
    if (reading.key) return { phone: reading.raw, phoneKey: reading.key };
  }
  return { phone: firstPopulated, phoneKey: null };
}

export function normalizeLead(
  record: SalesforceRecord,
  mapping: SalesforceFieldMapping,
  platformPriority: readonly string[] = DEFAULT_PLATFORM_PRIORITY,
  /**
   * The qualification bar. Supplied, the verdict is resolved here from the
   * band fields; omitted, it stays null and nothing downstream claims one.
   */
  bar?: QualificationBar,
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
    selfReportedAnnualRevenue: num(record, mapping.lead.selfReportedAnnualRevenue),
    selfReportedTimeInBusiness: num(record, mapping.lead.selfReportedTimeInBusinessMonths),
    industry: str(record, mapping.lead.industry),
    state: str(record, mapping.lead.state),
    revenueBand: readRevenueBand(record, mapping),
    ...readLeadPhone(record, mapping),
    isConverted: record.IsConverted === true,
    convertedOpportunityId: str(record, 'ConvertedOpportunityId'),
    mergedInto: str(record, 'MasterRecordId'),
    // The verdict, not a number. `selfReportedRevenue` above stays what the
    // merchant actually said in a numeric field — it does not acquire a band's
    // lower bound, which would be read as revenue by anything banding leads.
    ...(bar
      ? (() => {
          const judged = judgeQualificationBands(record, mapping, bar);
          return {
            mqlVerdict: judged.verdict,
            mqlUndeterminableReason: judged.reason,
          };
        })()
      : { mqlVerdict: null, mqlUndeterminableReason: null }),
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
    dealType: str(record, mapping.opportunity.dealType),
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
  bar: QualificationBar,
): StageEventRow | null {
  const result = qualifyLead(
    {
      revenue: {
        monthly: lead.selfReportedRevenue,
        annual: lead.selfReportedAnnualRevenue,
      },
      timeInBusinessMonths: lead.selfReportedTimeInBusiness,
    },
    bar,
  );
  if (result.qualified !== true) return null;
  return { opportunityExternalId, stage, occurredAt: lead.createdAt, origin: 'computed' };
}

/**
 * The incremental pull.
 *
 * `exclusion` applies to Lead only, and applies in the WHERE clause rather than
 * after the fetch: an out-of-scope record is never read, so it cannot reach
 * Postgres through a later bug. Opportunities are not filtered — an opportunity
 * exists because somebody worked a deal, whatever the lead's origin, and the
 * cold-outreach workstream does not create them. If that changes it becomes a
 * second rule set here rather than a reuse of this one.
 */
export function buildIncrementalQuery(
  mapping: SalesforceFieldMapping,
  object: 'Lead' | 'Opportunity',
  since: Date | null,
  exclusion: LeadExclusionConfig = NO_LEAD_EXCLUSION,
  /** Fields a describe reported absent. See `selectFields`. */
  omit: Iterable<string> = [],
): string {
  const fields = selectFields(mapping, object, omit).join(', ');
  const clauses = [
    since ? `SystemModstamp > ${since.toISOString()}` : null,
    object === 'Lead' ? inboundClause(exclusion) : null,
  ].filter((c): c is string => c != null);
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  return `SELECT ${fields} FROM ${object}${where} ORDER BY SystemModstamp ASC`;
}

/**
 * Ids per `Id IN (...)` lookup.
 *
 * A Salesforce id is 18 characters and costs 21 in the encoded URL, so 200 ids
 * is roughly 4KB of query string — comfortably inside every limit in the path,
 * and small enough that the margin survives a longer object name.
 */
const MERGE_LOOKUP_BATCH = 200;

/**
 * Which objects Salesforce can merge.
 *
 * Merge is defined on Lead, Account, Contact and Case, and `MasterRecordId`
 * exists only on those — on Opportunity it is not an empty column, it is not a
 * column, and asking for it fails the whole query. So a deleted opportunity is
 * simply deleted: there is no second interpretation to rule out, and looking
 * for one turns a working reconciliation into a 400.
 */
const MERGEABLE = new Set(['Lead', 'Account', 'Contact', 'Case']);

export type Reconciliation = {
  /**
   * Set when the requested window reached further back than `getDeleted`
   * serves, carrying the start that was asked for. Deletions before the clamp
   * were not checked and cannot be: unknowable rather than absent.
   */
  clampedFrom?: Date | null;
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
  /**
   * `getDeleted` is bounded at both ends, and either bound is a 400 that throws
   * the whole sync — so the run records `failed` and the watermark never
   * advances. Both are clamped here rather than left to fail.
   *
   * **Narrower than a minute**: `startDate must be at least one minute greater
   * than endDate`. Reachable as soon as a sync can run twice inside a minute,
   * which "Sync now" and the hourly endpoint both allow. The start is pulled
   * back rather than the pass skipped — `getDeleted` is idempotent, so a few
   * extra seconds cost nothing, while skipping would let a deletion in the
   * narrow window go unseen.
   *
   * **Older than thirty days**: `startDate cannot be more than 30 days ago`.
   * This is the documented limit on how long the sync may be broken before
   * deletions are lost for good, and it is reached by any catch-up run with a
   * `since` older than a month. Clamping keeps the run alive and `clamped`
   * says the older part of the window went unchecked, which is the honest
   * report: those deletions are not absent, they are unknowable.
   */
  const MIN_WINDOW_MS = 61_000;
  const MAX_LOOKBACK_MS = 29 * 24 * 60 * 60 * 1000;
  const earliestAllowed = new Date(until.getTime() - MAX_LOOKBACK_MS);
  let start = since;
  let clamped: Date | null = null;
  if (start < earliestAllowed) {
    clamped = start;
    start = earliestAllowed;
  }
  if (until.getTime() - start.getTime() < MIN_WINDOW_MS) {
    start = new Date(until.getTime() - MIN_WINDOW_MS);
  }

  const deleted = await client.getDeleted(object, start, until);
  const clampedFrom = clamped;
  const deletedIds = deleted.deletedRecords.map((r) => r.id);

  if (deletedIds.length === 0) return { deletedIds: [], merges: [], clampedFrom };
  if (!MERGEABLE.has(object)) return { deletedIds, merges: [], clampedFrom };

  // Merged losers keep a row, soft-deleted, pointing at the survivor. Only
  // queryAll can see them, and every merge also shows up in getDeleted — so the
  // deletions have to be filtered against this, or a merge is processed twice.
  //
  // Batched because the query travels in the URL. An org that has been running
  // for years returns thousands of deleted ids from a first full sync, and one
  // `Id IN (...)` over all of them is a URI Salesforce refuses with a 414 —
  // which arrives as a failed sync rather than as anything naming the cause.
  const merged: { Id: string; MasterRecordId: string | null }[] = [];
  for (let i = 0; i < deletedIds.length; i += MERGE_LOOKUP_BATCH) {
    const ids = deletedIds
      .slice(i, i + MERGE_LOOKUP_BATCH)
      .map((id) => `'${id}'`)
      .join(',');
    merged.push(
      ...(await client.query<{ Id: string; MasterRecordId: string | null }>(
        `SELECT Id, MasterRecordId FROM ${object} WHERE Id IN (${ids}) AND MasterRecordId != null`,
        true,
      )),
    );
  }

  const merges = merged
    .filter((row) => row.MasterRecordId)
    .map((row) => ({ loserId: row.Id, survivorId: row.MasterRecordId! }));
  const mergedIds = new Set(merges.map((m) => m.loserId));

  return { deletedIds: deletedIds.filter((id) => !mergedIds.has(id)), merges, clampedFrom };
}
