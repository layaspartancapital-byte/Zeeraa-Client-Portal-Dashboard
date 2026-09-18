import { describe, expect, it } from 'vitest';
import {
  classifyDisposition,
  DEFAULT_ALOWARE_MAPPING as M,
  normalizeCall,
  normalizeCalls,
  readSeconds,
} from '../src/aloware/calls';

const TZ = 'America/New_York';

/**
 * Fixtures use the column names and the value vocabulary of the real export,
 * with invented numbers: a test fixture must never carry a real merchant's
 * phone number.
 */
function record(overrides: Record<string, unknown> = {}) {
  return {
    'Communication ID': '900001',
    'Started At': '2026-06-19 11:32:04',
    Type: 'call',
    Direction: 'outbound',
    'Disposition Status': 'completed',
    'Talk Time': '00:01:20',
    Duration: '00:01:45',
    'Contact Number': '+13125551234',
    'Contact ID': 'C-1',
    'User Name': 'A Rep',
    ...overrides,
  };
}

describe('readSeconds', () => {
  it('reads the hh:mm:ss the export actually writes', () => {
    expect(readSeconds('00:01:20')).toBe(80);
    expect(readSeconds('01:00:00')).toBe(3600);
    expect(readSeconds('00:00:00')).toBe(0);
  });

  it('reads mm:ss and plain seconds too', () => {
    expect(readSeconds('2:05')).toBe(125);
    expect(readSeconds('45')).toBe(45);
  });

  it('is null, not zero, for an unreadable value', () => {
    // A call of unknown length is not a call of no length; zeros would
    // understate every conversation they were averaged into.
    for (const raw of ['', null, undefined, 'n/a', '--']) {
      expect(readSeconds(raw)).toBeNull();
    }
  });
});

describe('classifyDisposition', () => {
  it('needs talk time as well as a completed status to call it connected', () => {
    // 26,311 of 28,863 calls are `completed`, and 13,376 of those talked for
    // under ten seconds. `completed` is a telephony event, not a conversation.
    expect(classifyDisposition('completed', M, 120).outcome).toBe('connected');
    expect(classifyDisposition('completed', M, 30).outcome).toBe('connected');
    expect(classifyDisposition('completed', M, 29).outcome).toBe('attempted');
    expect(classifyDisposition('completed', M, 0).outcome).toBe('attempted');
  });

  it('flags a completed call that was answered and cut short', () => {
    // Counted as attempted, but not lost: this is a finding about the list.
    expect(classifyDisposition('completed', M, 4)).toMatchObject({
      outcome: 'attempted',
      answeredBriefly: true,
    });
    expect(classifyDisposition('completed', M, 0).answeredBriefly).toBe(false);
  });

  it('keeps abandoned as its own outcome', () => {
    // 2,002 of the export. Neither a conversation nor an agent's attempt.
    expect(classifyDisposition('abandoned', M, 0).outcome).toBe('abandoned');
  });

  it('classifies every other disposition this export contains as attempted', () => {
    for (const d of ['failed', 'missed', 'voicemail', 'dead-end']) {
      const r = classifyDisposition(d, M, 0);
      expect(r.outcome, d).toBe('attempted');
      expect(r.recognised, d).toBe(true);
    }
  });

  it('reports an unknown disposition rather than absorbing it', () => {
    const r = classifyDisposition('queued-elsewhere', M, 0);
    // Attempted is the conservative direction: connected would invent a
    // conversation, abandoned would blame the merchant.
    expect(r.outcome).toBe('attempted');
    expect(r.recognised).toBe(false);
  });

  it('is case and whitespace insensitive', () => {
    expect(classifyDisposition('  Abandoned ', M, 0).outcome).toBe('abandoned');
  });
});

describe('normalizeCall', () => {
  it('reads Started At in the tenant zone, not the server zone', () => {
    // The export writes no offset. Parsed as UTC, every call lands four hours
    // early and speed to lead reads as a desk that never picks up.
    const r = normalizeCall(record(), M, TZ);
    expect(r.row?.occurredAt.toISOString()).toBe('2026-06-19T15:32:04.000Z');
  });

  it('keys the contact number for the lead join', () => {
    const r = normalizeCall(record({ 'Contact Number': '(312) 555-1234' }), M, TZ);
    expect(r.row?.contactKey).toBe('3125551234');
  });

  it('keeps the row when the number cannot be keyed', () => {
    // The call happened. It simply cannot be joined to a lead, which is a
    // coverage fact rather than a reason to drop a call from the volume.
    const r = normalizeCall(record({ 'Contact Number': '+442079460958' }), M, TZ);
    expect(r.row).not.toBeNull();
    expect(r.row?.contactKey).toBeNull();
  });

  it('skips an SMS by Type and says which type it was', () => {
    // 252 of the 29,115 records are SMS. They are not calls and must not enter
    // a call volume or a connect rate.
    const r = normalizeCall(record({ Type: 'sms' }), M, TZ);
    expect(r.row).toBeNull();
    expect(r.row === null && r.type).toBe('sms');
  });

  it('drops a record with no Communication ID', () => {
    // Without the natural key there is nothing to de-duplicate on, so this row
    // would double-count on every re-import.
    const r = normalizeCall(record({ 'Communication ID': '' }), M, TZ);
    expect(r.row).toBeNull();
    expect(r.row === null && r.reason).toBe('no Communication ID');
  });

  it('drops a record with no usable timestamp', () => {
    const r = normalizeCall(record({ 'Started At': 'unknown' }), M, TZ);
    expect(r.row).toBeNull();
    expect(r.row === null && r.reason).toBe('no usable Started At');
  });

  it('keeps the vendor disposition verbatim', () => {
    // So a change of threshold or of classification is a query, not a
    // re-import.
    expect(normalizeCall(record(), M, TZ).row?.disposition).toBe('completed');
  });

  it('reads direction from the export and falls back to unknown', () => {
    expect(normalizeCall(record(), M, TZ).row?.direction).toBe('outbound');
    expect(normalizeCall(record({ Direction: 'Inbound' }), M, TZ).row?.direction).toBe('inbound');
    expect(normalizeCall(record({ Direction: '' }), M, TZ).row?.direction).toBe('unknown');
  });
});

describe('normalizeCalls', () => {
  it('counts the three outcomes and keeps SMS out of all of them', () => {
    const result = normalizeCalls(
      [
        record({ 'Communication ID': '1', 'Talk Time': '00:02:00' }),
        record({ 'Communication ID': '2', 'Talk Time': '00:00:04' }),
        record({ 'Communication ID': '3', 'Disposition Status': 'abandoned', 'Talk Time': '00:00:00' }),
        record({ 'Communication ID': '4', Type: 'sms' }),
      ],
      TZ,
      M,
    );
    expect(result.rows).toHaveLength(3);
    expect(result.counts).toEqual({ connected: 1, attempted: 1, abandoned: 1 });
    expect(result.skippedByType).toEqual({ sms: 1 });
    expect(result.answeredBriefly).toBe(1);
  });

  it('reports unkeyable numbers by reason rather than silently', () => {
    const result = normalizeCalls(
      [
        record({ 'Communication ID': '1', 'Contact Number': '' }),
        record({ 'Communication ID': '2', 'Contact Number': '555-0100' }),
      ],
      TZ,
      M,
    );
    expect(result.unkeyedNumbers).toEqual({ empty: 1, too_short: 1 });
  });

  it('reports the span the calls actually cover', () => {
    const result = normalizeCalls(
      [
        record({ 'Communication ID': '1', 'Started At': '2026-06-19 11:32:04' }),
        record({ 'Communication ID': '2', 'Started At': '2026-09-17 17:09:42' }),
      ],
      TZ,
      M,
    );
    expect(result.span.earliest?.toISOString()).toBe('2026-06-19T15:32:04.000Z');
    expect(result.span.latest?.toISOString()).toBe('2026-09-17T21:09:42.000Z');
  });

  it('counts dropped records by reason', () => {
    const result = normalizeCalls(
      [
        record({ 'Communication ID': '' }),
        record({ 'Communication ID': '2', 'Started At': '' }),
      ],
      TZ,
      M,
    );
    expect(result.rows).toHaveLength(0);
    expect(result.dropped).toEqual({ 'no Communication ID': 1, 'no usable Started At': 1 });
  });
});
