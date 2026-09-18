import { describe, expect, it } from 'vitest';
import {
  buildStageHistoryQuery,
  extractStageHistoryEvents,
  normaliseStageName,
  STAGE_NAME_ALIASES,
} from '../src/salesforce/stage-history';

const row = (opp: string, when: string, newValue: unknown, oldValue: unknown = 'Underwriting') => ({
  OpportunityId: opp,
  CreatedDate: when,
  OldValue: oldValue,
  NewValue: newValue,
});

describe('buildStageHistoryQuery', () => {
  it('asks only for StageName transitions, oldest first', () => {
    const q = buildStageHistoryQuery();
    expect(q).toContain("Field = 'StageName'");
    expect(q).toContain('FROM OpportunityFieldHistory');
    expect(q).toContain('ORDER BY CreatedDate ASC');
    expect(q).not.toContain('LIMIT');
  });

  it('bounds an incremental run with a dateTime literal', () => {
    // `CreatedDate` on history is a DateTime, so unlike `Lead.ConvertedDate`
    // this one does take a full timestamp.
    const q = buildStageHistoryQuery(new Date('2026-09-18T10:00:00.000Z'));
    expect(q).toContain('CreatedDate >= 2026-09-18T10:00:00.000Z');
  });
});

describe('extractStageHistoryEvents', () => {
  it('emits an approval event for a transition into Approved', () => {
    const { events, counts } = extractStageHistoryEvents([
      row('006A', '2026-07-01T12:00:00.000+0000', 'Approved'),
    ]);
    expect(events).toEqual([
      {
        opportunityExternalId: '006A',
        stage: 'uw_approved',
        occurredAt: new Date('2026-07-01T12:00:00.000Z'),
        origin: 'observed',
      },
    ]);
    expect(counts).toEqual({ uw_approved: 1 });
  });

  it('folds every retired decline label onto one event', () => {
    const { counts } = extractStageHistoryEvents([
      row('1', '2026-07-01T00:00:00.000+0000', 'Declined'),
      row('2', '2026-07-02T00:00:00.000+0000', 'Declined by Lender'),
      row('3', '2026-07-03T00:00:00.000+0000', 'Declined in Final'),
      row('4', '2026-07-04T00:00:00.000+0000', 'Closed Lost'),
    ]);
    expect(counts).toEqual({ declined: 4 });
  });

  it('does not emit stages that already have a stamped field', () => {
    // Emitting these as well as their timestamp field would count one
    // transition twice for the same deal.
    const { events, counts, unrecognised } = extractStageHistoryEvents([
      row('1', '2026-07-01T00:00:00.000+0000', 'Underwriting'),
      row('2', '2026-07-01T00:00:00.000+0000', 'Offer Received'),
      row('3', '2026-07-01T00:00:00.000+0000', 'Funded'),
      row('4', '2026-07-01T00:00:00.000+0000', 'Contracts In'),
    ]);
    expect(events).toEqual([]);
    expect(counts).toEqual({});
    expect(unrecognised).toEqual({});
  });

  it('counts a value the alias map has never seen instead of dropping it', () => {
    const { events, unrecognised } = extractStageHistoryEvents([
      row('1', '2026-07-01T00:00:00.000+0000', 'Sent To Syndication'),
      row('2', '2026-07-02T00:00:00.000+0000', 'Sent To Syndication'),
    ]);
    expect(events).toEqual([]);
    expect(unrecognised).toEqual({ 'Sent To Syndication': 2 });
  });

  it('reports the retained window it actually saw', () => {
    const { span } = extractStageHistoryEvents([
      row('1', '2026-03-20T14:05:26.000+0000', 'Approved'),
      row('2', '2026-09-18T17:27:44.000+0000', 'Approved'),
      row('3', '2026-06-01T00:00:00.000+0000', 'Approved'),
    ]);
    expect(span.earliest).toEqual(new Date('2026-03-20T14:05:26.000Z'));
    expect(span.latest).toEqual(new Date('2026-09-18T17:27:44.000Z'));
  });

  it('keeps both moments when a deal is approved twice', () => {
    const { events } = extractStageHistoryEvents([
      row('006A', '2026-07-01T00:00:00.000+0000', 'Approved'),
      row('006A', '2026-08-01T00:00:00.000+0000', 'Approved', 'Declined'),
    ]);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.occurredAt.toISOString()))).toEqual(
      new Set(['2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z']),
    );
  });

  it('skips rows with no opportunity or no usable stamp', () => {
    const { events } = extractStageHistoryEvents([
      { OpportunityId: '', CreatedDate: '2026-07-01T00:00:00.000+0000', NewValue: 'Approved' },
      { OpportunityId: '006B', CreatedDate: 'not a date', NewValue: 'Approved' },
      { OpportunityId: '006C', CreatedDate: null, NewValue: 'Approved' },
    ]);
    expect(events).toEqual([]);
  });

  it('normalises the underscored and hyphenated spellings', () => {
    expect(normaliseStageName('UW_Approved')).toBe('uw approved');
    expect(normaliseStageName('Declined-by-Lender')).toBe('declined by lender');
    expect(STAGE_NAME_ALIASES[normaliseStageName('UW_Approved')]).toBe('uw_approved');
  });
});

describe('the alias map covers every label this org has produced', () => {
  it('knows each StageName value seen in OpportunityFieldHistory', () => {
    // Taken from a live aggregate over the org's history, so a picklist change
    // that this map has not been told about fails here rather than silently
    // dropping transitions in production.
    const observed = [
      'Declined', 'Underwriting', 'Approved', 'Offer Received', 'Closed Lost',
      'Application In', 'Contracts Requested', 'Contracts In', 'Funded',
      'Declined by Lender', 'Application Missing Info', 'Renewal Prospecting',
      'Package In', 'Offers Presented', 'Pending Bank Verification',
      'Declined in Final', 'Hot Lead', 'In Final UW', 'Qualification',
    ];
    const { unrecognised } = extractStageHistoryEvents(
      observed.map((v, i) => row(`006${i}`, '2026-07-01T00:00:00.000+0000', v)),
    );
    expect(unrecognised).toEqual({});
  });
});
