import type { SalesforceClient } from './client';

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

/** Every Salesforce field this mapping needs, for the SELECT clause. */
export function selectFields(
  mapping: SalesforceFieldMapping,
  object: 'Lead' | 'Opportunity',
): string[] {
  const wanted = collect(mapping);
  const fields = (object === 'Lead' ? wanted.lead : wanted.opportunity).map(([f]) => f);
  const standard =
    object === 'Lead'
      ? ['Id', 'CreatedDate', 'SystemModstamp', 'IsConverted', 'ConvertedOpportunityId', 'MasterRecordId']
      : ['Id', 'CreatedDate', 'SystemModstamp', 'StageName', 'IsClosed', 'IsWon'];
  return [...new Set([...standard, ...fields])];
}
