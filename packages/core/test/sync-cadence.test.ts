import { describe, expect, it } from 'vitest';
import type { BusinessHours } from '../src/business-hours';
import { nextRefreshAt, salesforceSyncDue, withinBusinessHours } from '../src/sync-cadence';

const desk: BusinessHours = {
  timezone: 'America/New_York',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  open: '09:00',
  close: '18:00',
  holidays: ['2026-11-26'],
};

const at = (iso: string) => new Date(iso);

describe('withinBusinessHours', () => {
  it('is open from the opening minute to before the closing one, in the tenant zone', () => {
    // Thursday 24 September 2026, EDT (UTC-4).
    expect(withinBusinessHours(at('2026-09-24T12:59:00Z'), desk)).toBe(false);
    expect(withinBusinessHours(at('2026-09-24T13:00:00Z'), desk)).toBe(true);
    expect(withinBusinessHours(at('2026-09-24T21:59:00Z'), desk)).toBe(true);
    expect(withinBusinessHours(at('2026-09-24T22:00:00Z'), desk)).toBe(false);
  });

  it('keeps 9am at 9am across the clock change', () => {
    // Monday 7 December 2026, EST (UTC-5): 13:30Z is 8:30am.
    expect(withinBusinessHours(at('2026-12-07T13:30:00Z'), desk)).toBe(false);
    expect(withinBusinessHours(at('2026-12-07T14:00:00Z'), desk)).toBe(true);
    expect(withinBusinessHours(at('2026-12-07T22:30:00Z'), desk)).toBe(true);
  });

  it('is closed at weekends and on holidays', () => {
    expect(withinBusinessHours(at('2026-09-26T15:00:00Z'), desk)).toBe(false); // Saturday
    expect(withinBusinessHours(at('2026-11-26T16:00:00Z'), desk)).toBe(false); // Thanksgiving
  });

  it('is always open on the 24/7 clock', () => {
    expect(withinBusinessHours(at('2026-09-27T07:00:00Z'), null)).toBe(true);
  });
});

describe('salesforceSyncDue', () => {
  it('reads every tick while the desk is open', () => {
    expect(salesforceSyncDue(at('2026-09-24T15:40:00Z'), desk)).toBe(true);
  });

  it('reads only the first tick of the hour while it is closed', () => {
    expect(salesforceSyncDue(at('2026-09-24T23:00:12Z'), desk)).toBe(true);
    expect(salesforceSyncDue(at('2026-09-24T23:10:05Z'), desk)).toBe(false);
    expect(salesforceSyncDue(at('2026-09-26T15:20:00Z'), desk)).toBe(false);
  });

  it('keeps ten minutes around the clock for a tenant with no hours', () => {
    expect(salesforceSyncDue(at('2026-09-26T03:20:00Z'), null)).toBe(true);
  });
});

describe('nextRefreshAt', () => {
  it('is ten minutes on while the desk is open', () => {
    expect(nextRefreshAt(at('2026-09-24T15:03:30Z'), desk).toISOString()).toBe('2026-09-24T15:13:30.000Z');
  });

  it('lands two minutes past the hour while it is closed, after the hourly sync', () => {
    expect(nextRefreshAt(at('2026-09-26T15:03:30Z'), desk).toISOString()).toBe('2026-09-26T16:02:00.000Z');
    // At least ten minutes on: a page drawn at 15:55 does not refresh at 16:02.
    expect(nextRefreshAt(at('2026-09-26T15:55:00Z'), desk).toISOString()).toBe('2026-09-26T17:02:00.000Z');
  });

  it('steps into the opening rather than waiting for the next hour', () => {
    // 8:30am EDT → the first ten-minute step past 9:00.
    expect(nextRefreshAt(at('2026-09-24T12:30:00Z'), { ...desk, open: '08:45' }).toISOString()).toBe(
      '2026-09-24T12:50:00.000Z',
    );
  });

  it('drops to hourly at the close', () => {
    // 5:55pm EDT: 6:05 is closed, so the next is 7:02pm.
    expect(nextRefreshAt(at('2026-09-24T21:55:00Z'), desk).toISOString()).toBe('2026-09-24T23:02:00.000Z');
  });
});
