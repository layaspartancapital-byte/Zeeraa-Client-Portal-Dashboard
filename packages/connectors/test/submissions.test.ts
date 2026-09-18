import { describe, expect, it } from 'vitest';
import {
  buildSubmissionQuery,
  normalizeSubmissions,
  type SubmissionMapping,
} from '../src/salesforce/submissions';

/**
 * The status values are Spartan's actual picklist, and the fixtures below are
 * shaped like the records the org returns — including the nested lender label,
 * which is the part a flat field read gets wrong.
 */
const MAPPING: SubmissionMapping = {
  object: 'csbs__Submission__c',
  opportunity: 'csbs__Opportunity__c',
  lender: 'csbs__Lender__c',
  lenderName: 'csbs__Lender__r.Name',
  status: 'csbs__Status__c',
  declineReason: 'Decline_Reason__c',
  offeredStatuses: ['Offer(s) Received'],
  declinedStatuses: ['Declined'],
  failedStatuses: ['Failed', 'Incomplete Application', 'Partial Submission'],
  openStatuses: ['Submitted', 'Pending', 'Closing', 'Closing Incomplete', 'Contract Ready'],
};

function record(overrides: Record<string, unknown> = {}) {
  return {
    Id: 'a0B1',
    csbs__Opportunity__c: '0061',
    csbs__Lender__c: '0011',
    csbs__Lender__r: { Name: 'CFG' },
    csbs__Status__c: 'Submitted',
    Decline_Reason__c: null,
    CreatedDate: '2026-08-01T12:00:00.000+0000',
    LastModifiedDate: '2026-08-03T09:30:00.000+0000',
    ...overrides,
  };
}

describe('buildSubmissionQuery', () => {
  it('names every mapped field once, and the object from configuration', () => {
    const q = buildSubmissionQuery(MAPPING);
    expect(q).toContain('FROM csbs__Submission__c');
    expect(q).toContain('csbs__Lender__r.Name');
    expect(q).toContain('ORDER BY CreatedDate ASC');
    // Id appears in the select list exactly once even though it is also a
    // standard field.
    expect(q.match(/\bId\b/g)?.length).toBe(1);
  });

  it('bounds an incremental run on LastModifiedDate, not CreatedDate', () => {
    // The status change is the thing worth re-reading, and it happens long
    // after creation. A window on CreatedDate would miss every lender answer
    // on a submission opened before it.
    const q = buildSubmissionQuery(MAPPING, new Date('2026-09-01T00:00:00Z'));
    expect(q).toContain('WHERE LastModifiedDate >= 2026-09-01T00:00:00.000Z');
    expect(q).not.toContain('CreatedDate >=');
  });

  it('omits the fields configuration does not name', () => {
    const q = buildSubmissionQuery({
      object: 'Sub__c',
      opportunity: 'Opp__c',
      status: 'Status__c',
      offeredStatuses: [],
      declinedStatuses: [],
    });
    expect(q).toBe(
      'SELECT Id, CreatedDate, LastModifiedDate, Opp__c, Status__c FROM Sub__c ' +
        'ORDER BY CreatedDate ASC',
    );
  });
});

describe('normalizeSubmissions', () => {
  it('classifies the three outcomes from configuration', () => {
    const { rows, counts } = normalizeSubmissions(
      [
        record({ Id: 'a1', csbs__Status__c: 'Offer(s) Received' }),
        record({ Id: 'a2', csbs__Status__c: 'Declined' }),
        record({ Id: 'a3', csbs__Status__c: 'Submitted' }),
      ],
      MAPPING,
    );
    expect(rows.map((r) => r.outcome)).toEqual(['offered', 'declined', 'undecided']);
    expect(counts).toEqual({ offered: 1, declined: 1, undecided: 1 });
  });

  it('reads the lender label through the relationship path', () => {
    const {
      rows: [row],
    } = normalizeSubmissions([record()], MAPPING);
    expect(row?.lenderName).toBe('CFG');
    expect(row?.lenderExternalId).toBe('0011');
  });

  it('leaves the lender label null rather than inventing one', () => {
    // A lookup to a record the integration user cannot read comes back null,
    // not missing. An 18-character id rendered as a lender name would look
    // like a real dimension value.
    const {
      rows: [row],
    } = normalizeSubmissions([record({ csbs__Lender__r: null })], MAPPING);
    expect(row?.lenderName).toBeNull();
    expect(row?.lenderExternalId).toBe('0011');
  });

  it('separates an open submission from one that failed', () => {
    const { rows } = normalizeSubmissions(
      [
        record({ Id: 'a1', csbs__Status__c: 'Pending' }),
        record({ Id: 'a2', csbs__Status__c: 'Failed' }),
      ],
      MAPPING,
    );
    expect(rows[0]?.undecidedReason).toBe('awaiting a lender answer');
    expect(rows[1]?.undecidedReason).toBe('submission did not complete');
    // Neither is a decision, so neither is a recognition failure.
    expect(rows.every((r) => r.outcome === 'undecided')).toBe(true);
  });

  it('reports a status nobody mapped rather than absorbing it', () => {
    const { rows, counts, unclassified } = normalizeSubmissions(
      [record({ csbs__Status__c: 'Offer Expired' })],
      MAPPING,
    );
    expect(unclassified).toEqual({ 'Offer Expired': 1 });
    expect(rows[0]?.undecidedReason).toBe('status "Offer Expired" is not classified');
    // Undecided, never a decision: an unrecognised status must not move a rate.
    expect(counts).toEqual({ offered: 0, declined: 0, undecided: 1 });
  });

  it('splits a multipicklist and drops the empty segments', () => {
    const {
      rows: [row],
    } = normalizeSubmissions(
      [
        record({
          csbs__Status__c: 'Declined',
          Decline_Reason__c: 'Insufficient Revenue / Cash Flow;;Bankruptcy;',
        }),
      ],
      MAPPING,
    );
    expect(row?.declineReasons).toEqual(['Insufficient Revenue / Cash Flow', 'Bankruptcy']);
  });

  it('keeps decline reasons null rather than an empty array', () => {
    const {
      rows: [row],
    } = normalizeSubmissions([record({ csbs__Status__c: 'Declined' })], MAPPING);
    expect(row?.declineReasons).toBeNull();
  });

  it('measures reason coverage per month, over declines only', () => {
    // Monthly because the field is being adopted, not because a month is a
    // natural unit here: one all-time figure would average an unused field
    // with an adopted one and describe neither.
    const { reasonCoverage } = normalizeSubmissions(
      [
        record({ Id: 'a1', csbs__Status__c: 'Declined', CreatedDate: '2026-08-04T00:00:00Z' }),
        record({
          Id: 'a2',
          csbs__Status__c: 'Declined',
          CreatedDate: '2026-09-04T00:00:00Z',
          Decline_Reason__c: 'Bankruptcy',
        }),
        // Not a decline, so it is in neither half of the coverage figure.
        record({ Id: 'a3', csbs__Status__c: 'Submitted', CreatedDate: '2026-09-05T00:00:00Z' }),
      ],
      MAPPING,
    );
    expect(reasonCoverage).toEqual({
      '2026-08': { declined: 1, withReason: 0 },
      '2026-09': { declined: 1, withReason: 1 },
    });
  });

  it('drops a submission with no parent deal or no date', () => {
    const { rows } = normalizeSubmissions(
      [
        record({ Id: 'a1', csbs__Opportunity__c: null }),
        record({ Id: 'a2', CreatedDate: null }),
        record({ Id: 'a3', CreatedDate: 'not a date' }),
        record({ Id: 'a4' }),
      ],
      MAPPING,
    );
    // A submission with no deal cannot be placed in a funnel and one with no
    // date cannot be placed in a period; either would be a row that inflates a
    // total and belongs to nothing.
    expect(rows.map((r) => r.externalId)).toEqual(['a4']);
  });

  it('reports the span the records actually cover', () => {
    const { span } = normalizeSubmissions(
      [
        record({ Id: 'a1', CreatedDate: '2026-06-18T00:00:00Z' }),
        record({ Id: 'a2', CreatedDate: '2026-09-18T00:00:00Z' }),
      ],
      MAPPING,
    );
    expect(span.earliest?.toISOString()).toBe('2026-06-18T00:00:00.000Z');
    expect(span.latest?.toISOString()).toBe('2026-09-18T00:00:00.000Z');
  });

  it('keeps the status change time as the proxy it is', () => {
    const {
      rows: [row],
    } = normalizeSubmissions([record()], MAPPING);
    expect(row?.submittedAt.toISOString()).toBe('2026-08-01T12:00:00.000Z');
    expect(row?.statusChangedAt?.toISOString()).toBe('2026-08-03T09:30:00.000Z');
  });
});
