import { SalesforceApiError, type DescribeField, type SalesforceClient } from './client';

/**
 * Asks an org the four questions phase 2 depends on, before anything is built
 * on top of the answers.
 *
 * Every check here is read-only and observational. It looks at conversions that
 * have already happened rather than creating a test lead, for two reasons: real
 * historical records are better evidence than one synthetic one, and a probe
 * that writes to a client's production CRM is not a probe.
 *
 * Nothing in this file interprets a missing answer charitably. "The field is
 * absent" and "the field exists and is always null" are different findings with
 * different remedies, and both are reported as blocking.
 */

export type Finding = {
  question: string;
  /**
   * `blocked` means work downstream cannot proceed honestly. It is not an
   * error — it is a dependency, and it renders as one (§9.5).
   */
  status: 'ok' | 'degraded' | 'blocked';
  summary: string;
  detail: string[];
  /** What somebody has to do, and who. */
  remedy?: string;
};

const CLICK_ID_PATTERNS = [
  /gclid/i,
  /gbraid/i,
  /wbraid/i,
  /msclkid/i,
  /fbclid/i,
  /li_fat_id/i,
  /click.?id/i,
];

const DECLINE_PATTERNS = [/decline/i, /reason/i, /loss/i, /lost/i];

function matching(fields: DescribeField[], patterns: RegExp[]): DescribeField[] {
  return fields.filter((f) => patterns.some((p) => p.test(f.name) || p.test(f.label)));
}

function pct(part: number, whole: number): string {
  if (whole === 0) return 'no records';
  return `${((part / whole) * 100).toFixed(1)}% (${part} of ${whole})`;
}

/**
 * Q1. Does the click ID survive Lead → Opportunity conversion?
 *
 * Standard Salesforce lead conversion only carries a custom Lead field across
 * if an explicit lead field mapping exists for it. Nothing in the field
 * metadata reveals whether that mapping is configured, so the only honest test
 * is to look at converted leads and see whether the value actually arrived.
 */
export async function probeClickIdSurvival(client: SalesforceClient): Promise<Finding> {
  const question = 'Does the click ID survive Lead → Opportunity conversion?';
  const detail: string[] = [];

  const [lead, opportunity] = await Promise.all([
    client.describe('Lead'),
    client.describe('Opportunity'),
  ]);

  const leadFields = matching(lead.fields, CLICK_ID_PATTERNS);
  const oppFields = matching(opportunity.fields, CLICK_ID_PATTERNS);

  detail.push(
    `Lead click-ID fields: ${leadFields.map((f) => f.name).join(', ') || 'none found'}`,
    `Opportunity click-ID fields: ${oppFields.map((f) => f.name).join(', ') || 'none found'}`,
  );

  if (leadFields.length === 0) {
    return {
      question,
      status: 'blocked',
      summary: 'No click-ID field exists on Lead. Attribution cannot be built.',
      detail,
      remedy:
        'The client’s Salesforce admin needs a custom field on Lead to hold the ' +
        'click ID, and the website forms need to capture and post it. Until both ' +
        'exist, every opportunity is unattributable and cost per funded deal ' +
        'cannot be computed for paid channels.',
    };
  }

  if (oppFields.length === 0) {
    return {
      question,
      status: 'blocked',
      summary:
        'Lead carries a click ID but Opportunity has nowhere to put it. The value ' +
        'is lost at conversion.',
      detail,
      remedy:
        'Add a matching custom field on Opportunity, then map it in Setup → ' +
        'Object Manager → Lead → Fields & Relationships → Map Lead Fields. ' +
        'Creating the field alone does nothing — conversion only carries a value ' +
        'across when the mapping exists.',
    };
  }

  // The decisive evidence: leads that have already converted.
  const leadField = leadFields[0]!.name;
  const oppField = oppFields[0]!.name;

  const converted = await client.query<{
    Id: string;
    ConvertedOpportunityId: string | null;
    [key: string]: unknown;
  }>(
    `SELECT Id, ConvertedOpportunityId, ${leadField} FROM Lead ` +
      `WHERE IsConverted = true AND ConvertedOpportunityId != null ` +
      `AND ${leadField} != null ORDER BY ConvertedDate DESC LIMIT 200`,
  );

  detail.push(`Converted leads with ${leadField} populated, sampled: ${converted.length}`);

  if (converted.length === 0) {
    return {
      question,
      status: 'blocked',
      summary:
        `Both fields exist, but no converted lead has ever carried a ${leadField}. ` +
        'Nothing proves the mapping works.',
      detail,
      remedy:
        'Either click IDs are not being captured on the forms, or no lead ' +
        'carrying one has converted yet. Confirm capture first, then convert one ' +
        'test lead with the field populated and re-run this probe. Do not assume ' +
        'the mapping works because both fields exist — it is a separate setting.',
    };
  }

  const oppIds = converted.map((l) => `'${l.ConvertedOpportunityId}'`).join(',');
  const opps = await client.query<{ Id: string; [key: string]: unknown }>(
    `SELECT Id, ${oppField} FROM Opportunity WHERE Id IN (${oppIds})`,
  );
  const byId = new Map(opps.map((o) => [o.Id, o]));

  let carried = 0;
  let mismatched = 0;
  for (const l of converted) {
    const opp = byId.get(l.ConvertedOpportunityId!);
    const from = l[leadField];
    const to = opp?.[oppField];
    if (to == null) continue;
    if (to === from) carried += 1;
    else mismatched += 1;
  }

  detail.push(
    `Click ID present on the resulting Opportunity: ${pct(carried, converted.length)}`,
    mismatched > 0 ? `Value differs between Lead and Opportunity: ${mismatched}` : 'No value mismatches',
  );

  if (carried === 0) {
    return {
      question,
      status: 'blocked',
      summary: `${leadField} is populated on Lead and arrives null on Opportunity every time.`,
      detail,
      remedy:
        `The lead field mapping from ${leadField} to ${oppField} is not configured. ` +
        'Setup → Object Manager → Lead → Map Lead Fields. Attribution must not ' +
        'be built until this is in place — it would silently attribute nothing.',
    };
  }

  if (carried < converted.length * 0.95) {
    return {
      question,
      status: 'degraded',
      summary: `The click ID reaches Opportunity on only ${pct(carried, converted.length)} of conversions.`,
      detail,
      remedy:
        'Partial carry-through usually means conversion happens by more than one ' +
        'route — a flow or Apex that bypasses the standard mapping. Attribution ' +
        'will under-report by roughly the gap; find the second route before ' +
        'quoting a cost per funded deal.',
    };
  }

  return {
    question,
    status: 'ok',
    summary: `${leadField} reaches Opportunity.${oppField ? ` As ${oppField}.` : ''}`,
    detail,
  };
}

/**
 * Q2. Which stage-timestamp source actually exists?
 *
 * `stage_events` is mandatory, and the brief allows either Field History or
 * explicit date fields. They are not equivalent: Field History has a retention
 * limit and covers the past, while date fields are exact but only start from
 * the day somebody creates them.
 */
export async function probeStageHistory(client: SalesforceClient): Promise<Finding> {
  const question = 'Where do per-stage timestamps come from?';
  const detail: string[] = [];

  let historyRows = 0;
  let historyAvailable = false;
  let earliest: string | undefined;

  try {
    const rows = await client.query<{ CreatedDate: string }>(
      `SELECT CreatedDate FROM OpportunityFieldHistory WHERE Field = 'StageName' ` +
        `ORDER BY CreatedDate ASC LIMIT 1`,
    );
    historyAvailable = true;
    earliest = rows[0]?.CreatedDate;

    const recent = await client.query<{ c: number }>(
      `SELECT COUNT(Id) c FROM OpportunityFieldHistory WHERE Field = 'StageName'`,
    );
    historyRows = Number((recent[0] as unknown as Record<string, unknown>)?.c ?? 0);
    detail.push(
      `OpportunityFieldHistory readable: yes`,
      `StageName history rows: ${historyRows}`,
      earliest ? `Earliest retained: ${earliest}` : 'No StageName history rows at all',
    );
  } catch (error) {
    detail.push(
      `OpportunityFieldHistory not readable: ${
        error instanceof SalesforceApiError ? error.body.slice(0, 200) : String(error)
      }`,
    );
  }

  const opportunity = await client.describe('Opportunity');
  const dateFields = opportunity.fields.filter(
    (f) => (f.type === 'date' || f.type === 'datetime') && f.custom,
  );
  detail.push(
    `Custom date/datetime fields on Opportunity: ${
      dateFields.map((f) => f.name).join(', ') || 'none'
    }`,
  );

  if (!historyAvailable && dateFields.length === 0) {
    return {
      question,
      status: 'blocked',
      summary: 'Neither field history nor stage date fields exist. Stage events cannot be built.',
      detail,
      remedy:
        'Enable field history tracking on Opportunity.StageName, or have the ' +
        'admin add a datetime field per stage. History is retrospective but ' +
        'retention-limited; date fields are exact but only from creation ' +
        'onwards. For cohorts and velocity across the baseline period, history ' +
        'is the only option — and if it is not already on, that past is gone.',
    };
  }

  if (historyAvailable && historyRows === 0) {
    return {
      question,
      status: 'blocked',
      summary: 'Field history is readable but holds no StageName rows.',
      detail,
      remedy:
        'Tracking is almost certainly not enabled for StageName. Setup → Object ' +
        'Manager → Opportunity → Fields & Relationships → Set History Tracking. ' +
        'Note that enabling it is not retrospective.',
    };
  }

  return {
    question,
    status: historyAvailable ? 'ok' : 'degraded',
    summary: historyAvailable
      ? `Field history carries ${historyRows} StageName transitions.`
      : 'No field history; stage dates would have to come from custom date fields.',
    detail,
    remedy: historyAvailable
      ? undefined
      : 'Confirm with the admin which date field corresponds to which stage before ' +
        'stage_events is built on them — the names are not self-evident.',
  };
}

/**
 * Q3. Does the decline reason exist, and is it actually filled in?
 *
 * Existence is not the question. A field that exists and is empty on every
 * record produces a decline-reason breakdown that is entirely "unspecified",
 * which is worse than showing nothing because it looks like an answer.
 */
export async function probeDeclineReason(client: SalesforceClient): Promise<Finding> {
  const question = 'Is a decline reason recorded in practice?';
  const detail: string[] = [];

  const opportunity = await client.describe('Opportunity');
  const candidates = matching(opportunity.fields, DECLINE_PATTERNS).filter(
    (f) => f.type === 'picklist' || f.type === 'string' || f.type === 'textarea',
  );

  detail.push(`Candidate fields: ${candidates.map((f) => `${f.name} (${f.type})`).join(', ') || 'none'}`);

  if (candidates.length === 0) {
    return {
      question,
      status: 'blocked',
      summary: 'No decline or loss reason field exists on Opportunity.',
      detail,
      remedy:
        'The funnel view’s decline-reason breakdown has no source. Either the ' +
        'admin adds and populates one, or that section is removed rather than ' +
        'rendered empty.',
    };
  }

  const field = candidates[0]!.name;
  // The meaningful denominator is lost deals, not all deals.
  const lost = await client.query<Record<string, unknown>>(
    `SELECT Id, ${field} FROM Opportunity WHERE IsClosed = true AND IsWon = false LIMIT 500`,
  );
  const populated = lost.filter((o) => o[field] != null && o[field] !== '').length;

  detail.push(`Closed-lost opportunities sampled: ${lost.length}`, `${field} populated: ${pct(populated, lost.length)}`);

  if (lost.length === 0) {
    return {
      question,
      status: 'degraded',
      summary: `${field} exists, but there are no closed-lost opportunities to judge it by.`,
      detail,
    };
  }

  if (populated === 0) {
    return {
      question,
      status: 'blocked',
      summary: `${field} exists and is empty on every closed-lost opportunity.`,
      detail,
      remedy:
        'Rendering this would produce a breakdown that is 100% "unspecified", ' +
        'which reads as an answer rather than an absence. Either the field starts ' +
        'being filled in, or the decline-reason section stays out.',
    };
  }

  if (populated < lost.length * 0.6) {
    return {
      question,
      status: 'degraded',
      summary: `${field} is populated on ${pct(populated, lost.length)} of closed-lost opportunities.`,
      detail,
      remedy:
        'Partial coverage is usable if the gap is shown. The breakdown must carry ' +
        'an explicit "not recorded" share rather than renormalising to 100% over ' +
        'the records that happen to have a value.',
    };
  }

  return {
    question,
    status: 'ok',
    summary: `${field} is populated on ${pct(populated, lost.length)} of closed-lost opportunities.`,
    detail,
  };
}

/**
 * Q4. Can the incremental sync see deletes and merges?
 *
 * `SystemModstamp` sees neither. A deleted row is simply absent from the next
 * pull, and the stale copy lives on in Postgres forever. A merge is worse: it
 * looks exactly like a deletion, except the record's history did not end — it
 * moved to the surviving record, and any attribution held against the loser
 * has to move with it rather than being dropped.
 */
export async function probeDeletesAndMerges(client: SalesforceClient): Promise<Finding> {
  const question = 'Does the incremental sync see deletes and merges?';
  const detail: string[] = [];
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);

  let deletesReadable = true;
  for (const sobject of ['Lead', 'Opportunity']) {
    try {
      const deleted = await client.getDeleted(sobject, thirtyDaysAgo, now);
      detail.push(
        `${sobject}: ${deleted.deletedRecords.length} deletions in the last 30 days ` +
          `(earliest available ${deleted.earliestDateAvailable})`,
      );
    } catch (error) {
      deletesReadable = false;
      detail.push(
        `${sobject}: getDeleted failed — ${
          error instanceof SalesforceApiError ? error.body.slice(0, 200) : String(error)
        }`,
      );
    }
  }

  // A merged loser keeps a row with IsDeleted = true and MasterRecordId set to
  // the survivor. Only queryAll can see it.
  let merged = 0;
  try {
    const rows = await client.query<{ Id: string; MasterRecordId: string }>(
      `SELECT Id, MasterRecordId FROM Lead WHERE MasterRecordId != null LIMIT 200`,
      true,
    );
    merged = rows.length;
    detail.push(`Merged leads visible via queryAll: ${merged}`);
  } catch (error) {
    detail.push(
      `queryAll for merged leads failed — ${
        error instanceof SalesforceApiError ? error.body.slice(0, 200) : String(error)
      }`,
    );
  }

  if (!deletesReadable) {
    return {
      question,
      status: 'blocked',
      summary: 'The getDeleted endpoint is not usable, so deletions cannot be detected at all.',
      detail,
      remedy:
        'The integration user needs the permission to query deleted records. ' +
        'Without it, deleted and merged leads stay in the warehouse forever and ' +
        'every count that includes them is overstated.',
    };
  }

  return {
    question,
    status: merged > 0 ? 'ok' : 'degraded',
    summary:
      merged > 0
        ? `Deletions and ${merged} merged leads are both visible. The sync must handle both.`
        : 'Deletions are visible; no merged leads found in the sample.',
    detail,
    remedy:
      merged > 0
        ? 'Merged losers must be re-pointed at MasterRecordId, not deleted — their ' +
          'attribution belongs to the surviving record.'
        : 'No merges in the sample does not mean none happen. Keep the merge path.',
  };
}

export async function runAllProbes(client: SalesforceClient): Promise<Finding[]> {
  return [
    await probeClickIdSurvival(client),
    await probeStageHistory(client),
    await probeQualificationInputs(client),
    await probeUnderwritingTimestamp(client),
    await probeDeclineReason(client),
    await probeDeletesAndMerges(client),
  ];
}

const REVENUE_PATTERNS = [/revenue/i, /gross/i, /sales/i, /volume/i];
const TIME_IN_BUSINESS_PATTERNS = [/time.?in.?business/i, /years.?in.?business/i, /tib/i, /inception/i, /established/i];

/**
 * Q5. Which fields carry revenue and time in business, and how often are they
 * empty?
 *
 * The MQL stage is derived from these two, so a large share of leads missing
 * both does not produce a smaller MQL count — it produces an MQL count that is
 * quietly wrong, because an unanswered form is not an unqualified lead. The
 * share has to be known before the number appears on a screen.
 */
export async function probeQualificationInputs(client: SalesforceClient): Promise<Finding> {
  const question = 'Which Lead fields carry revenue and time in business, and how complete are they?';
  const detail: string[] = [];

  const lead = await client.describe('Lead');
  const numeric = lead.fields.filter((f) =>
    ['currency', 'double', 'int', 'percent', 'number'].includes(f.type),
  );
  const dateish = lead.fields.filter((f) => ['date', 'datetime'].includes(f.type));

  const revenueFields = matching(numeric, REVENUE_PATTERNS);
  const tibFields = [...matching(numeric, TIME_IN_BUSINESS_PATTERNS), ...matching(dateish, TIME_IN_BUSINESS_PATTERNS)];

  detail.push(
    `Revenue candidates: ${revenueFields.map((f) => `${f.name} (${f.type})`).join(', ') || 'none'}`,
    `Time-in-business candidates: ${tibFields.map((f) => `${f.name} (${f.type})`).join(', ') || 'none'}`,
  );

  if (revenueFields.length === 0 || tibFields.length === 0) {
    return {
      question,
      status: 'blocked',
      summary: 'Cannot find a field for revenue, time in business, or both.',
      detail,
      remedy:
        'MQL is derived from these two. Without them the stage cannot be computed ' +
        'at all, and the funnel loses its second step. Confirm the exact API ' +
        'names with the admin — they may not match the naming this probe looks for.',
    };
  }

  const revenue = revenueFields[0]!.name;
  const tib = tibFields[0]!.name;

  const rows = await client.query<Record<string, unknown>>(
    `SELECT Id, ${revenue}, ${tib} FROM Lead ORDER BY CreatedDate DESC LIMIT 2000`,
  );

  const hasRevenue = rows.filter((r) => r[revenue] != null).length;
  const hasTib = rows.filter((r) => r[tib] != null).length;
  const hasBoth = rows.filter((r) => r[revenue] != null && r[tib] != null).length;
  const hasNeither = rows.filter((r) => r[revenue] == null && r[tib] == null).length;

  detail.push(
    `Leads sampled: ${rows.length}`,
    `${revenue} populated: ${pct(hasRevenue, rows.length)}`,
    `${tib} populated: ${pct(hasTib, rows.length)}`,
    `Both populated (MQL is computable): ${pct(hasBoth, rows.length)}`,
    `Neither populated: ${pct(hasNeither, rows.length)}`,
  );

  if (rows.length === 0) {
    return { question, status: 'degraded', summary: 'No leads to sample.', detail };
  }

  const computable = hasBoth / rows.length;

  if (computable < 0.5) {
    return {
      question,
      status: 'blocked',
      summary: `MQL is computable for only ${pct(hasBoth, rows.length)} of leads.`,
      detail,
      remedy:
        'The MQL count would understate by roughly the missing share, and it would ' +
        'do so silently. Either the forms start capturing both attributes, or the ' +
        'funnel shows MQL with an explicit "not determined" share beside it rather ' +
        'than a bare count.',
    };
  }

  if (computable < 0.9) {
    return {
      question,
      status: 'degraded',
      summary: `MQL is computable for ${pct(hasBoth, rows.length)} of leads.`,
      detail,
      remedy:
        'The remainder renders as "not determined" rather than being counted as ' +
        'unqualified — an unanswered form is not a failed test.',
    };
  }

  return {
    question,
    status: 'ok',
    summary: `Revenue from ${revenue}, time in business from ${tib}; both present on ${pct(hasBoth, rows.length)} of leads.`,
    detail,
  };
}

/**
 * Q6. Does the underwriting timestamp mark submission, or pickup?
 *
 * SQL is defined as submission to underwriting. If a queue sits between the two
 * and `csbs__Application_In_Date_Time__c` is the real submission moment, then
 * using the underwriting timestamp overstates Lead→SQL velocity by the length
 * of the queue — invisibly, and in a direction that flatters nobody.
 */
export async function probeUnderwritingTimestamp(
  client: SalesforceClient,
  submissionField = 'csbs__Application_In_Date_Time__c',
  underwritingField = 'csbs__Underwriting_Date_Time__c',
): Promise<Finding> {
  const question = 'Does the underwriting timestamp mark submission or pickup?';
  const detail: string[] = [];

  const opportunity = await client.describe('Opportunity');
  const names = new Set(opportunity.fields.map((f) => f.name.toLowerCase()));

  if (!names.has(submissionField.toLowerCase())) {
    return {
      question,
      status: 'ok',
      summary: `${submissionField} does not exist, so ${underwritingField} is the only submission signal.`,
      detail: [`Opportunity has no ${submissionField}.`],
    };
  }

  const rows = await client.query<Record<string, unknown>>(
    `SELECT Id, ${submissionField}, ${underwritingField} FROM Opportunity ` +
      `WHERE ${submissionField} != null AND ${underwritingField} != null ` +
      `ORDER BY CreatedDate DESC LIMIT 1000`,
  );

  if (rows.length === 0) {
    return {
      question,
      status: 'degraded',
      summary: 'Both fields exist but no record carries both, so they cannot be compared.',
      detail,
    };
  }

  const gapsHours = rows
    .map((r) => {
      const submitted = new Date(String(r[submissionField])).getTime();
      const underwritten = new Date(String(r[underwritingField])).getTime();
      return (underwritten - submitted) / 3_600_000;
    })
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  const median = gapsHours[Math.floor(gapsHours.length / 2)] ?? 0;
  const p90 = gapsHours[Math.floor(gapsHours.length * 0.9)] ?? 0;
  const sameDay = gapsHours.filter((h) => Math.abs(h) < 24).length;

  detail.push(
    `Opportunities carrying both: ${rows.length}`,
    `Median gap: ${median.toFixed(1)} hours`,
    `90th percentile gap: ${p90.toFixed(1)} hours`,
    `Within the same day: ${pct(sameDay, gapsHours.length)}`,
  );

  // Same-day on nearly everything means the queue, if any, is shorter than the
  // reporting grain and the simpler field is the right one.
  if (sameDay / gapsHours.length >= 0.9) {
    return {
      question,
      status: 'ok',
      summary: `The two land on the same day for ${pct(sameDay, gapsHours.length)} of deals. Stay with ${underwritingField}.`,
      detail,
    };
  }

  return {
    question,
    status: 'degraded',
    summary:
      `A queue sits between submission and underwriting: median ${median.toFixed(1)} hours, ` +
      `90th percentile ${p90.toFixed(1)}.`,
    detail,
    remedy:
      `${submissionField} is the better SQL timestamp. Using ${underwritingField} would ` +
      'overstate Lead→SQL velocity by the length of the queue, and understate the ' +
      'time deals spend waiting to be picked up — which is itself worth reporting.',
  };
}
