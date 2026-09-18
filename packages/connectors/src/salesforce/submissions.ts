import type { SalesforceClient } from './client';
import type { SalesforceRecord } from './sync';

/**
 * Submissions: one deal's application to one lender.
 *
 * This is the grain the funnel was missing. Approve, offer and decline are
 * things a *lender* does, and a deal is with several lenders at once — so the
 * opportunity-level fields hold whichever answer was written last, and the
 * question "which lender declines this profile, and why" cannot be asked of
 * them at all.
 *
 * Self-contained, like `stage-history.ts` and for the same reason: the object
 * and every field on it are named in configuration, so a client whose broker
 * package differs — or who has no submission object — changes a row rather than
 * this file. `validateSubmissionMapping` is separate from `validateMapping`
 * because a missing submission object is not a missing field: it means this
 * tenant has no lender grain, which is a supported state and not a fault.
 */
export type SubmissionMapping = {
  /** API name of the submission object, e.g. `csbs__Submission__c`. */
  object: string;
  /** Lookup to the parent deal. */
  opportunity: string;
  /** Lookup to the lender. Its own object is not ingested; the label is. */
  lender?: string;
  /**
   * Relationship path to the lender's label, e.g. `csbs__Lender__r.Name`.
   *
   * A path rather than a field because the name lives on the related record.
   * SOQL returns it nested, so it is read by walking the dots — a flat lookup
   * would find nothing and every lender would render as its 18-character id.
   */
  lenderName?: string;
  /** The status picklist. */
  status: string;
  /** The decline-reason field. A multipicklist in Spartan's org. */
  declineReason?: string;
  /**
   * Which status values count as a lender decision, and which way.
   *
   * Configuration, because a status vocabulary is a fact about one org. Only
   * these two lists enter a rate; everything else is `undecided`, which is a
   * third answer rather than a soft no.
   */
  offeredStatuses: string[];
  declinedStatuses: string[];
  /**
   * Statuses that mean the submission never reached a lender cleanly, as
   * opposed to being open. Both are undecided and outside every denominator,
   * but 687 submissions awaiting an answer and 12 that broke are different
   * facts and the UI says which.
   */
  failedStatuses?: string[];
  /**
   * Statuses that mean a lender has it and has not answered.
   *
   * Listed explicitly so that `unclassified` can mean what it says: a status
   * value nobody has mapped. Without this list every open submission would be
   * reported as an unrecognised value, 687 of them, and the one genuinely new
   * picklist entry would be invisible in the noise.
   */
  openStatuses?: string[];
};

export type SubmissionRow = {
  externalId: string;
  opportunityExternalId: string;
  lenderExternalId: string | null;
  lenderName: string | null;
  status: string | null;
  outcome: 'offered' | 'declined' | 'undecided';
  undecidedReason: string | null;
  declineReasons: string[] | null;
  submittedAt: Date;
  statusChangedAt: Date | null;
};

export type SubmissionResult = {
  rows: SubmissionRow[];
  /** Outcomes seen, for the sync record. */
  counts: { offered: number; declined: number; undecided: number };
  /**
   * Status values the mapping does not classify, with how often each appeared.
   *
   * These become `undecided`, which is the safe direction — an unknown status
   * must never be counted as a decision — but they are reported so a new
   * picklist value surfaces as a number rather than as a slow drift in the
   * denominator.
   */
  unclassified: Record<string, number>;
  /** The window the records actually cover, for the coverage note. */
  span: { earliest: Date | null; latest: Date | null };
  /** Declines carrying at least one reason, over declines. Per month. */
  reasonCoverage: Record<string, { declined: number; withReason: number }>;
};

const normalise = (value: unknown) => String(value ?? '').trim().toLowerCase();

/**
 * Reads a value that may sit behind a relationship path.
 *
 * `csbs__Lender__r.Name` comes back as a nested object, and a related record
 * that is absent comes back as null rather than as a missing key — so each hop
 * is checked rather than assumed.
 */
function readPath(record: SalesforceRecord, path: string): unknown {
  let value: unknown = record;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object') return null;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/**
 * The SOQL. `since` bounds an incremental run against `LastModifiedDate`
 * rather than `CreatedDate`: a submission's status changes after it is created
 * — that change is the whole point of re-reading it — and a window on creation
 * would miss every lender answer on an older submission.
 */
export function buildSubmissionQuery(
  mapping: SubmissionMapping,
  since?: Date,
  limit?: number,
): string {
  const fields = [
    'Id',
    'CreatedDate',
    'LastModifiedDate',
    mapping.opportunity,
    mapping.status,
    mapping.lender,
    mapping.lenderName,
    mapping.declineReason,
  ].filter((f): f is string => Boolean(f));

  const where = since ? ` WHERE LastModifiedDate >= ${since.toISOString()}` : '';
  return (
    `SELECT ${[...new Set(fields)].join(', ')} FROM ${mapping.object}${where}` +
    ` ORDER BY CreatedDate ASC${limit ? ` LIMIT ${limit}` : ''}`
  );
}

/**
 * Whether this org has the object at all, and whether the mapped fields are
 * readable.
 *
 * Returns `{ present: false }` rather than throwing when the object is absent:
 * a tenant without a submission object has no lender grain, the funnel says so
 * through a blocked dependency, and the rest of the sync is unaffected.
 */
export async function validateSubmissionMapping(
  client: SalesforceClient,
  mapping: SubmissionMapping,
): Promise<{ present: boolean; missingFields: string[] }> {
  let describe;
  try {
    describe = await client.describe(mapping.object);
  } catch {
    return { present: false, missingFields: [] };
  }
  const available = new Set(describe.fields.map((f) => f.name.toLowerCase()));
  const wanted = [
    mapping.opportunity,
    mapping.status,
    mapping.lender,
    mapping.lenderName,
    mapping.declineReason,
  ].filter((f): f is string => Boolean(f));
  return {
    present: true,
    // A relationship path is not a field on this object and would always look
    // absent here. Its own hop (`csbs__Lender__c`) is checked, and if the path
    // beyond it is wrong the label reads null — which shows up as an unnamed
    // lender rather than as a wrong number.
    missingFields: wanted.filter((f) => !f.includes('.') && !available.has(f.toLowerCase())),
  };
}

/**
 * Records into rows.
 *
 * A status the mapping does not classify becomes `undecided` and is counted in
 * `unclassified`. Erring towards undecided is deliberate: a rate's denominator
 * is the thing most easily corrupted here, and an unrecognised status entering
 * it as either a yes or a no would move a published figure silently.
 */
export function normalizeSubmissions(
  records: readonly SalesforceRecord[],
  mapping: SubmissionMapping,
): SubmissionResult {
  const offered = new Set(mapping.offeredStatuses.map(normalise));
  const declined = new Set(mapping.declinedStatuses.map(normalise));
  const failed = new Set((mapping.failedStatuses ?? []).map(normalise));
  const open = new Set((mapping.openStatuses ?? []).map(normalise));

  const rows: SubmissionRow[] = [];
  const counts = { offered: 0, declined: 0, undecided: 0 };
  const unclassified: Record<string, number> = {};
  const reasonCoverage: Record<string, { declined: number; withReason: number }> = {};
  let earliest: Date | null = null;
  let latest: Date | null = null;

  for (const record of records) {
    const externalId = String(record.Id ?? '').trim();
    const opportunityExternalId = String(record[mapping.opportunity] ?? '').trim();
    const created = record.CreatedDate ? new Date(String(record.CreatedDate)) : null;
    // A submission with no parent deal cannot be placed in any funnel, and one
    // with no creation date cannot be placed in any period.
    if (!externalId || !opportunityExternalId || !created || Number.isNaN(created.getTime())) {
      continue;
    }

    if (!earliest || created < earliest) earliest = created;
    if (!latest || created > latest) latest = created;

    const status = record[mapping.status] == null ? null : String(record[mapping.status]).trim();
    const key = normalise(status);

    let outcome: SubmissionRow['outcome'];
    let undecidedReason: string | null = null;
    if (offered.has(key)) {
      outcome = 'offered';
    } else if (declined.has(key)) {
      outcome = 'declined';
    } else {
      outcome = 'undecided';
      if (!status) {
        undecidedReason = 'no status recorded';
      } else if (failed.has(key)) {
        undecidedReason = 'submission did not complete';
      } else if (open.has(key)) {
        undecidedReason = 'awaiting a lender answer';
      } else {
        // Neither a decision, nor known to be open, nor known to have failed.
        // Counted, so a picklist value added after this mapping was written
        // shows up as a number instead of quietly joining the undecided pile.
        undecidedReason = `status "${status}" is not classified`;
        unclassified[status] = (unclassified[status] ?? 0) + 1;
      }
    }
    counts[outcome] += 1;

    // A multipicklist arrives semicolon-separated. Empty segments are dropped
    // rather than becoming a reason called "".
    const rawReasons = mapping.declineReason ? readPath(record, mapping.declineReason) : null;
    const declineReasons = rawReasons
      ? String(rawReasons)
          .split(';')
          .map((r) => r.trim())
          .filter(Boolean)
      : [];

    if (outcome === 'declined') {
      const month = created.toISOString().slice(0, 7);
      const bucket = (reasonCoverage[month] ??= { declined: 0, withReason: 0 });
      bucket.declined += 1;
      if (declineReasons.length > 0) bucket.withReason += 1;
    }

    const modified = record.LastModifiedDate ? new Date(String(record.LastModifiedDate)) : null;

    rows.push({
      externalId,
      opportunityExternalId,
      lenderExternalId: mapping.lender
        ? (record[mapping.lender] == null ? null : String(record[mapping.lender]))
        : null,
      lenderName: lenderLabel(record, mapping),
      status,
      outcome,
      undecidedReason,
      declineReasons: declineReasons.length > 0 ? declineReasons : null,
      submittedAt: created,
      statusChangedAt: modified && !Number.isNaN(modified.getTime()) ? modified : null,
    });
  }

  return { rows, counts, unclassified, span: { earliest, latest }, reasonCoverage };
}

function lenderLabel(record: SalesforceRecord, mapping: SubmissionMapping): string | null {
  if (!mapping.lenderName) return null;
  const value = readPath(record, mapping.lenderName);
  if (value == null) return null;
  const label = String(value).trim();
  return label === '' ? null : label;
}
