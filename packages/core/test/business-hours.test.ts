import { describe, expect, it } from 'vitest';
import {
  businessSecondsBetween,
  clockLabel,
  parseBusinessHours,
  responseSeconds,
  type BusinessHours,
} from '../src/business-hours';

const desk: BusinessHours = {
  timezone: 'America/New_York',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  open: '09:00',
  close: '18:00',
  holidays: [],
};

/** A September Eastern wall-clock time (EDT, UTC-4), as the instant it names. */
function et(text: string): Date {
  return new Date(`${text.replace(' ', 'T')}:00-04:00`);
}

const MIN = 60;
const HOUR = 3600;

describe('businessSecondsBetween', () => {
  it('counts a lead inside hours on the wall clock', () => {
    // Tuesday 22 September 2026, 10:00 → 10:04.
    expect(businessSecondsBetween(et('2026-09-22 10:00'), et('2026-09-22 10:04'), desk)).toBe(
      4 * MIN,
    );
  });

  it('starts an overnight lead at the next opening', () => {
    // Created 20:00 Tuesday, called 09:02 Wednesday: two minutes, not thirteen hours.
    expect(businessSecondsBetween(et('2026-09-22 20:00'), et('2026-09-23 09:02'), desk)).toBe(
      2 * MIN,
    );
  });

  it('counts a call before the opening as a zero wait', () => {
    // Created 22:00, rung 07:30 the next morning: the desk beat the clock.
    expect(businessSecondsBetween(et('2026-09-22 22:00'), et('2026-09-23 07:30'), desk)).toBe(0);
  });

  it('skips the weekend', () => {
    // Created Friday 17:00, called Monday 09:30: one hour Friday, thirty minutes Monday.
    expect(businessSecondsBetween(et('2026-09-25 17:00'), et('2026-09-28 09:30'), desk)).toBe(
      HOUR + 30 * MIN,
    );
  });

  it('stops the clock at closing and restarts it at opening', () => {
    // 17:00 Tuesday to 10:00 Wednesday: one hour each side of the night.
    expect(businessSecondsBetween(et('2026-09-22 17:00'), et('2026-09-23 10:00'), desk)).toBe(
      2 * HOUR,
    );
  });

  it('treats a holiday as a closed day', () => {
    const withHoliday = { ...desk, holidays: ['2026-09-23'] };
    // Tuesday 17:00 → Thursday 09:10, with Wednesday closed.
    expect(
      businessSecondsBetween(et('2026-09-22 17:00'), et('2026-09-24 09:10'), withHoliday),
    ).toBe(HOUR + 10 * MIN);
  });

  it('keeps the hours on the wall clock across a DST change', () => {
    // Clocks go back on Sunday 1 November 2026. Friday 17:00 EDT to Monday
    // 09:15 EST is still one hour and fifteen minutes of desk time.
    const friday = new Date('2026-10-30T17:00:00-04:00');
    const monday = new Date('2026-11-02T09:15:00-05:00');
    expect(businessSecondsBetween(friday, monday, desk)).toBe(HOUR + 15 * MIN);
  });

  it('is zero for an interval that does not run forwards', () => {
    expect(businessSecondsBetween(et('2026-09-22 10:05'), et('2026-09-22 10:00'), desk)).toBe(0);
  });
});

describe('responseSeconds', () => {
  it('is the wall clock with no hours configured', () => {
    expect(responseSeconds(et('2026-09-22 20:00'), et('2026-09-23 09:02'), null)).toBe(
      13 * HOUR + 2 * MIN,
    );
  });

  it('is the business clock with hours configured', () => {
    expect(responseSeconds(et('2026-09-22 20:00'), et('2026-09-23 09:02'), desk)).toBe(2 * MIN);
  });
});

describe('parseBusinessHours', () => {
  const row = {
    timezone: 'America/New_York',
    days: ['fri', 'mon', 'tue', 'wed', 'thu'],
    open: '09:00',
    close: '18:00',
    holidays: [],
  };

  it('reads the row and orders the days', () => {
    expect(parseBusinessHours(row)?.days).toEqual(['mon', 'tue', 'wed', 'thu', 'fri']);
  });

  it('takes a missing holiday list as none', () => {
    const { holidays: _, ...rest } = row;
    expect(parseBusinessHours(rest)?.holidays).toEqual([]);
  });

  it('refuses a row it cannot read rather than guessing a clock', () => {
    expect(parseBusinessHours(null)).toBeNull();
    expect(parseBusinessHours({ ...row, timezone: 'Eastern' })).toBeNull();
    expect(parseBusinessHours({ ...row, open: '9am' })).toBeNull();
    expect(parseBusinessHours({ ...row, close: '08:00' })).toBeNull();
    expect(parseBusinessHours({ ...row, days: [] })).toBeNull();
    expect(parseBusinessHours({ ...row, days: ['monday'] })).toBeNull();
    expect(parseBusinessHours({ ...row, holidays: ['25 December'] })).toBeNull();
  });
});

describe('clockLabel', () => {
  it('states the hours the way the desk would', () => {
    expect(clockLabel(desk)).toBe('business hours · 9–6 ET, Mon–Fri');
  });

  it('says 24/7 when no hours are configured', () => {
    expect(clockLabel(null)).toBe('24/7');
  });

  it('keeps minutes and lists days that are not a run', () => {
    expect(clockLabel({ ...desk, open: '08:30', days: ['mon', 'wed', 'fri'] })).toBe(
      'business hours · 8:30–6 ET, Mon, Wed, Fri',
    );
  });
});
