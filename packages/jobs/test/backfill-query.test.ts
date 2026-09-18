import { describe, expect, it } from 'vitest';
import { buildBackfillQuery } from '../src/salesforce/backfill';

/**
 * The converted-Lead backfill query.
 *
 * Pinned because a malformed literal here fails as a Salesforce 400 at request
 * time rather than as a type error, and the `since` branch went unexercised
 * until the hourly incremental started passing it on every run.
 */
describe('buildBackfillQuery', () => {
  const fields = ['gclid__c', 'acq_fbclid__c'];

  it('compares ConvertedDate against a bare date, not a timestamp', () => {
    const q = buildBackfillQuery(fields, new Date('2026-09-18T16:33:01.123Z'));
    // `ConvertedDate` is a Date field; SOQL rejects a dateTime literal against
    // it with "malformed query", which is a 400 and not a retryable failure.
    expect(q).toContain('ConvertedDate >= 2026-09-18');
    expect(q).not.toContain('2026-09-18T16:33:01');
    expect(q).not.toMatch(/ConvertedDate >= '/);
  });

  it('asks only for leads that carry at least one click id', () => {
    const q = buildBackfillQuery(fields);
    expect(q).toContain('IsConverted = true');
    expect(q).toContain('ConvertedOpportunityId != null');
    expect(q).toContain("(gclid__c != null OR acq_fbclid__c != null)");
  });

  it('omits the date condition entirely when no window is given', () => {
    expect(buildBackfillQuery(fields)).not.toContain('ConvertedDate >=');
  });

  it('orders oldest first and applies a limit only when asked', () => {
    expect(buildBackfillQuery(fields)).toContain('ORDER BY ConvertedDate ASC');
    expect(buildBackfillQuery(fields)).not.toContain('LIMIT');
    expect(buildBackfillQuery(fields, undefined, 50)).toContain('LIMIT 50');
  });

  it('selects the click id fields it was asked for', () => {
    const q = buildBackfillQuery(fields);
    expect(q).toContain('SELECT Id, ConvertedOpportunityId, ConvertedDate, gclid__c, acq_fbclid__c');
  });
});
