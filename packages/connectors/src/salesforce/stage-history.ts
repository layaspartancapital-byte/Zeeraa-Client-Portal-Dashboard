import type { SalesforceRecord, StageEventRow } from './sync';

/**
 * Funnel stages read out of `OpportunityFieldHistory`.
 *
 * Some stages have no timestamp field anybody fills in. `csbs__Approved_Date_Time__c`
 * exists on Opportunity and is empty on all 716 of them, so UW approved had no
 * source and rendered as a blocked dependency. But history tracking *is* on for
 * `StageName`, and the org holds 1,327 transitions across 688 opportunities —
 * including 118 into `Approved`, 112 of them straight out of `Underwriting`.
 * A tracked transition carries the moment it happened, so the stage is
 * observable after all; it was only unobservable through the field somebody
 * expected to find it in.
 *
 * Two properties of this source govern everything below.
 *
 * **It has a horizon.** Field history begins when tracking was switched on —
 * 2026-03-20 for `StageName` in this org — and nothing before it exists to be
 * read. That is a coverage limit, not a gap in the funnel, and it has to travel
 * with the number rather than be discovered by whoever asks why a 2025 quarter
 * looks empty.
 *
 * **It speaks a dead vocabulary.** History preserves the label as it was
 * written, so it contains stage names the picklist no longer offers — `Declined`,
 * `Offer Received`, `Hot Lead`, `In Final UW`, `Qualification`, `Package In`,
 * `Pending Bank Verification`. Matching on the current picklist alone would
 * silently drop them. So every value observed in this org is listed below and
 * mapped deliberately, including the ones that are deliberately *not* funnel
 * stages, and anything unlisted is counted and reported rather than ignored.
 */

/**
 * Every `StageName` value this org's history contains, canonicalised.
 *
 * `null` means "recognised, and deliberately not a funnel stage" — a working
 * sub-state rather than a step the funnel counts. Distinguishing that from
 * "never seen before" is the whole point: the first is a decision, the second
 * is a thing to go and look at.
 */
export const STAGE_NAME_ALIASES: Record<string, string | null> = {
  // --- the approval stage, which is why this module exists -----------------
  approved: 'uw_approved',
  'uw approved': 'uw_approved',
  'underwriting approved': 'uw_approved',

  // --- declines, kept as their own event ------------------------------------
  declined: 'declined',
  'declined by lender': 'declined',
  'declined in final': 'declined',
  'closed lost': 'declined',

  // --- stages that already have a stamped field. Recognised so an unlisted
  //     value is genuinely unlisted; not emitted, because the field is the
  //     better source and emitting both would double-count a transition
  //     against a timestamp for the same deal.
  underwriting: null,
  'in final uw': null,
  'application in': null,
  'application missing info': null,
  'package in': null,
  'pending bank verification': null,
  'offer received': null,
  'offers presented': null,
  'contracts requested': null,
  'contracts in': null,
  funded: null,
  'renewal prospecting': null,
  qualification: null,
  'hot lead': null,
  'new lead': null,
  nurture: null,
};

/** Which canonical stages this module is allowed to emit. */
const EMITTED = new Set(['uw_approved', 'declined']);

export function normaliseStageName(raw: string): string {
  return raw.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The history query.
 *
 * Only `StageName`, because that is the only tracked field that carries a
 * funnel transition — the rest of the tracked set is notes, owner and a balance.
 * `since` bounds an incremental run; without it the query walks the whole
 * retained window, which is what a backfill wants.
 */
export function buildStageHistoryQuery(since?: Date, limit?: number): string {
  const conditions = ["Field = 'StageName'"];
  if (since) conditions.push(`CreatedDate >= ${since.toISOString()}`);
  return (
    'SELECT OpportunityId, CreatedDate, OldValue, NewValue FROM OpportunityFieldHistory ' +
    `WHERE ${conditions.join(' AND ')} ORDER BY CreatedDate ASC${limit ? ` LIMIT ${limit}` : ''}`
  );
}

export type StageHistoryResult = {
  events: StageEventRow[];
  /** The retained window actually observed, for the coverage note. */
  span: { earliest: Date | null; latest: Date | null };
  /** Transitions seen per canonical stage, for the sync report. */
  counts: Record<string, number>;
  /**
   * Values the alias map does not know, with how often each appeared. A new
   * picklist value lands here rather than disappearing.
   */
  unrecognised: Record<string, number>;
};

/**
 * History rows into stage events.
 *
 * A transition *into* a stage is the evidence; `OldValue` is carried only to
 * decide that a transition happened at all. Re-entering a stage produces a
 * second event, which is correct — the upsert key is
 * (opportunity, stage, occurredAt), so a deal that was approved twice holds
 * both moments and the funnel's distinct-opportunity count still counts it once.
 */
export function extractStageHistoryEvents(records: readonly SalesforceRecord[]): StageHistoryResult {
  const events: StageEventRow[] = [];
  const counts: Record<string, number> = {};
  const unrecognised: Record<string, number> = {};
  let earliest: Date | null = null;
  let latest: Date | null = null;

  for (const record of records) {
    const opportunityExternalId = String(record.OpportunityId ?? '').trim();
    const stamp = record.CreatedDate ? new Date(String(record.CreatedDate)) : null;
    if (!opportunityExternalId || !stamp || Number.isNaN(stamp.getTime())) continue;

    if (!earliest || stamp < earliest) earliest = stamp;
    if (!latest || stamp > latest) latest = stamp;

    const raw = record.NewValue;
    if (raw == null || String(raw).trim() === '') continue;
    const key = normaliseStageName(String(raw));

    // `undefined` is a label the map has never seen; an explicit `null` is one
    // it knows and deliberately does not emit. Conflating them would hide a new
    // picklist value among the decisions.
    const stage = STAGE_NAME_ALIASES[key];
    if (stage === undefined) {
      unrecognised[String(raw)] = (unrecognised[String(raw)] ?? 0) + 1;
      continue;
    }
    if (stage === null || !EMITTED.has(stage)) continue;

    counts[stage] = (counts[stage] ?? 0) + 1;
    // `observed`: Salesforce stamped this transition when it happened. It is a
    // record of an event, not an inference from other attributes — which is the
    // line `origin` draws. What makes it different from a stamped field is its
    // horizon, and that travels as coverage rather than as provenance.
    events.push({ opportunityExternalId, stage, occurredAt: stamp, origin: 'observed' });
  }

  return { events, span: { earliest, latest }, counts, unrecognised };
}
