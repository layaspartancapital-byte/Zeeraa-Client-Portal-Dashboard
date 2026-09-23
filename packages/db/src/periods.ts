import { and, gte, isNull, lte, type SQL } from 'drizzle-orm';
import * as schema from './schema/index';

/**
 * Which rows a reporting period holds, one predicate per table.
 *
 * Every report filters on the tenant-local date written at ingest, never on
 * the instant. `DateRange` is a pair of tenant-local calendar days, so
 * comparing it with `occurred_at` meant turning `2026-09-30` into an instant —
 * which the code did as UTC midnight, filing everything after 8pm Eastern on
 * the 30th under October. These are the only place that comparison is made,
 * so a new screen cannot make it again.
 */
export type DayRange = { start: string; end: string };

/**
 * Stage events in the period that count.
 *
 * `excluded_reason` is part of this rather than a second thing to remember:
 * an event a configured rule excludes — a renewal reaching Funded — is real
 * but is not counted anywhere, and a report that forgot the clause would lower
 * every cost per funded deal by a deal the spend did not buy.
 */
export function stageEventsIn(range: DayRange): SQL {
  return and(
    gte(schema.stageEvents.occurredOn, range.start),
    lte(schema.stageEvents.occurredOn, range.end),
    countedStageEvent(),
  )!;
}

/** The counting clause alone, for reads that are not bounded by a period. */
export function countedStageEvent(): SQL {
  return isNull(schema.stageEvents.excludedReason);
}

/**
 * Leads created in the period that count. A lead that converted into a
 * renewal-type deal carries `excluded_reason` and is in no stage and no rate —
 * renewals are not marketing's at any stage.
 */
export function leadsCreatedIn(range: DayRange): SQL {
  return and(
    gte(schema.leads.createdOn, range.start),
    lte(schema.leads.createdOn, range.end),
    isNull(schema.leads.excludedReason),
  )!;
}

export function callsIn(range: DayRange): SQL {
  return and(
    gte(schema.calls.occurredOn, range.start),
    lte(schema.calls.occurredOn, range.end),
  )!;
}

export function submissionsIn(range: DayRange): SQL {
  return and(
    gte(schema.submissions.submittedOn, range.start),
    lte(schema.submissions.submittedOn, range.end),
  )!;
}
