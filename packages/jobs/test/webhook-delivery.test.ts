import { describe, expect, it } from 'vitest';
import { mergeReasons, tally } from '../src/webhook-delivery';

/**
 * The counters that make a silent endpoint legible.
 *
 * The arithmetic is trivial; the cap is not, and it is the only part of this
 * with a failure mode. A rejection reason quotes the value that caused it —
 * `not a call (2)` — which is what makes the record actionable and also what
 * makes it unbounded the moment a vendor starts sending something new every
 * time. One row per tenant per day is only a bound if the row is bounded too.
 */
describe('tally', () => {
  it('counts a refusal as one, because it has no records', () => {
    expect(tally({ kind: 'refused', reason: 'unauthenticated' })).toEqual({ unauthenticated: 1 });
  });

  it('counts records, not requests, for a batch the reader read', () => {
    expect(
      tally({
        kind: 'read',
        accepted: 4,
        rejected: [
          { reason: 'call still in flight (ringing)', count: 9 },
          { reason: 'not a call (2)', count: 2 },
        ],
      }),
    ).toEqual({ 'call still in flight (ringing)': 9, 'not a call (2)': 2 });
  });

  it('gives a blank reason a name rather than an empty key', () => {
    expect(tally({ kind: 'refused', reason: '   ' })).toEqual({ '(no reason given)': 1 });
  });

  it('truncates a reason long enough to bloat the row', () => {
    const [key] = Object.keys(tally({ kind: 'refused', reason: 'x'.repeat(500) }));
    expect(key!.length).toBe(120);
    expect(key!.endsWith('…')).toBe(true);
  });
});

describe('mergeReasons', () => {
  it('adds to what is already stored', () => {
    expect(mergeReasons({ unauthenticated: 40 }, { unauthenticated: 1 })).toEqual({
      unauthenticated: 41,
    });
  });

  it('keeps a stored reason the delivery did not mention', () => {
    expect(mergeReasons({ 'not a call (2)': 3 }, { unauthenticated: 1 })).toEqual({
      'not a call (2)': 3,
      unauthenticated: 1,
    });
  });

  it('caps the distinct reasons and keeps counting past the cap', () => {
    const stored = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`reason ${i}`, 1]),
    );
    const merged = mergeReasons(stored, { 'a brand new reason': 7, 'another new one': 2 });

    // Forty named reasons, plus the one bucket the overflow goes into. The
    // wording of the new ones is lost; the fact that nine records were refused
    // is not, which is the right half to keep.
    expect(Object.keys(merged)).toHaveLength(41);
    expect(merged['a brand new reason']).toBeUndefined();
    expect(merged['(other reasons)']).toBe(9);
  });

  it('still adds to a reason already stored once the cap is reached', () => {
    const stored = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`reason ${i}`, 1]));
    const merged = mergeReasons(stored, { 'reason 0': 5 });
    expect(Object.keys(merged)).toHaveLength(40);
    expect(merged['reason 0']).toBe(6);
  });

  it('survives a stored value that is not a number', () => {
    // The column is jsonb and nothing at the database level says the values are
    // counts. A row hand-edited during an incident must not crash ingestion.
    expect(mergeReasons({ good: 2, bad: 'lots' }, { good: 1 })).toEqual({ good: 3 });
  });
});
