import type { SalesforceClient } from './client';
import type { SubmissionMapping } from './submissions';

/**
 * Which Salesforce field holds which of our concepts.
 *
 * Lives in `connections.config.fieldMapping`, per connection, because it is a
 * fact about one org rather than about the product. Spartan's stage timestamps
 * come from a managed package (`csbs__`); the next client's will not.
 */
export type SalesforceFieldMapping = {
  lead: {
    /** Platform key → Lead field holding that platform's click ID. */
    clickIds: Record<string, string>;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmContent?: string;
    utmTerm?: string;
    landingPage?: string;
    /** Monthly gross. */
    selfReportedRevenue?: string;
    /** Annual gross. Either may be present; both are read, monthly wins. */
    selfReportedAnnualRevenue?: string;
    selfReportedTimeInBusinessMonths?: string;
    /**
     * Ordered candidates for the qualification bar's revenue input.
     *
     * A list rather than a field because the answer is spread across eight
     * columns in three vocabularies, and no single one is populated on more
     * than half the leads. Read in order; the first *resolvable* reading wins,
     * so a field holding a straddling band does not shadow a later field that
     * answers cleanly.
     *
     * `period` says what the field means, not what the label says — a field
     * named for annual revenue holding `Less than $180,000` is $15,000 a month.
     */
    revenueBands?: { field: string; period: 'monthly' | 'annual' }[];
    /** The same, for time in business. Units come from each label. */
    timeInBusinessBands?: string[];
    /**
     * Fields excluded from the bar pending a decode key.
     *
     * `MIYB_Years_in_Business__c` is the best-populated time-in-business field
     * in the org at 53%, and its five values are `0000 | 1000 | 1100 | 1111 |
     * 1110`. Those are not durations. Reading them as numbers would be an
     * invention; ignoring them silently would hide the single biggest reason
     * MQL coverage is short of its ceiling. So they are named here, counted,
     * and reported as the blocker they are.
     */
    undecodableFields?: { field: string; why: string }[];
    /**
     * Ordered candidates for the merchant's phone number.
     *
     * A list because a CRM holds several — `Phone`, `MobilePhone`, a form
     * field — and any one of them may be the only populated one on a given
     * lead. Read in order; the first that yields a ten-digit key wins, so a
     * field holding a switchboard extension does not shadow a mobile number
     * that joins.
     *
     * This is the only thing the dialer can be joined on: a call knows the
     * number it dialled and nothing else about a lead.
     */
    phones?: string[];
    industry?: string;
    state?: string;
  };
  opportunity: {
    /** Empty until the fields exist and the lead mapping is configured. */
    clickIds: Record<string, string>;
    amount?: string;
    fundedAmount?: string;
    declineReason?: string;
    industry?: string;
    state?: string;
  };
  /** Funnel stage key → Opportunity datetime field. */
  stages: Record<string, string>;
  /**
   * Timestamps worth keeping that are not configured funnel stages. Written to
   * `stage_events` and simply not rendered in the stage flow.
   */
  extraStageEvents: Record<string, string>;
  /**
   * Stages with no field, established by computation instead. The value names
   * the rule, so the UI can say which rule and mark the stage as computed
   * rather than observed.
   */
  derivedStages: Record<string, 'qualification_minimums' | 'opportunity_created'>;
  /**
   * The lender-grain submission object, where the client has one.
   *
   * Optional because it is a property of the client's broker package rather
   * than of the product. A tenant without it has no lender grain, which is a
   * supported state: the submission metrics render as a blocked dependency and
   * nothing else changes. Its own type lives in `submissions.ts` with the
   * module that reads it.
   */
  submissions?: SubmissionMapping;
};

export type FieldIssue = {
  object: 'Lead' | 'Opportunity';
  field: string;
  purpose: string;
  /**
   * Field-level security produces exactly the same describe output as a field
   * that was never created, so the two are reported together rather than
   * guessed between.
   */
  reason: 'absent_or_unreadable';
};

export type MappingValidation = {
  ok: boolean;
  issues: FieldIssue[];
  /** Purposes that are missing and block downstream work. */
  blocking: string[];
};

function collect(mapping: SalesforceFieldMapping) {
  const lead: [string, string][] = Object.entries(mapping.lead.clickIds).map(([p, f]) => [
    f,
    `click ID for ${p}`,
  ]);
  for (const [key, field] of Object.entries(mapping.lead)) {
    if (key === 'clickIds' || typeof field !== 'string') continue;
    lead.push([field, key]);
  }
  // The band candidates are lists rather than single fields, so the loop above
  // steps over them — and a field that is never selected is a field the
  // qualification bar cannot see. Validation runs off this too, so an absent
  // band field is reported and dropped rather than failing the whole query.
  for (const candidate of mapping.lead.revenueBands ?? []) {
    lead.push([candidate.field, `revenue band (${candidate.period})`]);
  }
  for (const field of mapping.lead.timeInBusinessBands ?? []) {
    lead.push([field, 'time-in-business band']);
  }
  // Selected in order to be *counted*: a lead whose only duration answer is an
  // undecodable flag needs to say so, which means knowing it is there.
  for (const candidate of mapping.lead.undecodableFields ?? []) {
    lead.push([candidate.field, 'undecodable, pending a key']);
  }
  // Also a list the string loop above steps over, and an unselected phone
  // field is a lead the dialer can never be joined to.
  for (const field of mapping.lead.phones ?? []) {
    lead.push([field, 'phone number']);
  }

  const opportunity: [string, string][] = Object.entries(mapping.opportunity.clickIds).map(
    ([p, f]) => [f, `click ID for ${p}`],
  );
  for (const [key, field] of Object.entries(mapping.opportunity)) {
    if (key === 'clickIds' || typeof field !== 'string') continue;
    opportunity.push([field, key]);
  }
  for (const [stage, field] of Object.entries(mapping.stages)) {
    opportunity.push([field, `stage timestamp: ${stage}`]);
  }
  for (const [event, field] of Object.entries(mapping.extraStageEvents)) {
    opportunity.push([field, `event timestamp: ${event}`]);
  }

  return { lead, opportunity };
}

/**
 * Checks every mapped field against the org before a sync runs.
 *
 * A field named in the mapping that the integration user cannot see would
 * otherwise produce a column of nulls that reads as "no data" rather than "not
 * connected". Validating up front turns that into a visible dependency (§9.5).
 */
export async function validateMapping(
  client: SalesforceClient,
  mapping: SalesforceFieldMapping,
): Promise<MappingValidation> {
  const [leadDescribe, oppDescribe] = await Promise.all([
    client.describe('Lead'),
    client.describe('Opportunity'),
  ]);

  const leadFields = new Set(leadDescribe.fields.map((f) => f.name.toLowerCase()));
  const oppFields = new Set(oppDescribe.fields.map((f) => f.name.toLowerCase()));
  const wanted = collect(mapping);
  const issues: FieldIssue[] = [];

  for (const [field, purpose] of wanted.lead) {
    if (!leadFields.has(field.toLowerCase())) {
      issues.push({ object: 'Lead', field, purpose, reason: 'absent_or_unreadable' });
    }
  }
  for (const [field, purpose] of wanted.opportunity) {
    if (!oppFields.has(field.toLowerCase())) {
      issues.push({ object: 'Opportunity', field, purpose, reason: 'absent_or_unreadable' });
    }
  }

  // A missing stage timestamp breaks cohorts and velocity for that stage; a
  // missing UTM field costs one slice. They are not the same severity.
  const blocking = issues
    .filter((i) => i.purpose.startsWith('stage timestamp') || i.purpose.startsWith('click ID'))
    .map((i) => `${i.object}.${i.field} (${i.purpose})`);

  return { ok: issues.length === 0, issues, blocking };
}

/**
 * Every Salesforce field this mapping needs, for the SELECT clause.
 *
 * `omit` drops fields a describe has already reported absent or unreadable.
 * SOQL rejects the entire query for one unknown field, so without this a
 * mapping naming a single field the org never created costs the whole sync —
 * every lead, every opportunity, every stage event — rather than the one slice
 * that field carries. `validateMapping` has the describe in hand well before
 * the query is built, and whether the shortfall is worth stopping for is its
 * `blocking` list to say, not SOQL's.
 *
 * Compared case-insensitively, like the validation that produces it: Salesforce
 * returns each field under its canonical casing, which a mapping need not match.
 */
export function selectFields(
  mapping: SalesforceFieldMapping,
  object: 'Lead' | 'Opportunity',
  omit: Iterable<string> = [],
): string[] {
  const dropped = new Set([...omit].map((f) => f.toLowerCase()));
  const wanted = collect(mapping);
  const fields = (object === 'Lead' ? wanted.lead : wanted.opportunity)
    .map(([f]) => f)
    .filter((f) => !dropped.has(f.toLowerCase()));
  const standard =
    object === 'Lead'
      ? ['Id', 'CreatedDate', 'SystemModstamp', 'IsConverted', 'ConvertedOpportunityId', 'MasterRecordId']
      : ['Id', 'CreatedDate', 'SystemModstamp', 'StageName', 'IsClosed', 'IsWon'];
  return [...new Set([...standard, ...fields])];
}

/** The absent fields from a validation, as `selectFields` wants them. */
export function absentFields(
  validation: MappingValidation,
  object: 'Lead' | 'Opportunity',
): string[] {
  return validation.issues.filter((i) => i.object === object).map((i) => i.field);
}
