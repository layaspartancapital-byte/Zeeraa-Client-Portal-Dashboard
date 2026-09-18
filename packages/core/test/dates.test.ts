import { describe, expect, it } from 'vitest';
import {
  bucketLabel,
  evenBucketsIn,
  monthBucketsIn,
  parseWallClock,
  previousRange,
  trailingMonths,
  trailingWindow,
} from '../src/dates';

describe('monthBucketsIn', () => {
  it('clips the first and last month to the window', () => {
    const buckets = monthBucketsIn({ start: '2026-06-20', end: '2026-09-18' });
    expect(buckets.map((b) => [b.key, b.start, b.end])).toEqual([
      ['2026-06', '2026-06-20', '2026-06-30'],
      ['2026-07', '2026-07-01', '2026-07-31'],
      ['2026-08', '2026-08-01', '2026-08-31'],
      ['2026-09', '2026-09-01', '2026-09-18'],
    ]);
  });

  it('handles a window inside one month', () => {
    expect(monthBucketsIn({ start: '2026-02-10', end: '2026-02-12' })).toEqual([
      { key: '2026-02', start: '2026-02-10', end: '2026-02-12' },
    ]);
  });
});

describe('evenBucketsIn', () => {
  /**
   * The alignment is the point: the newest bucket must be a whole period, or a
   * chart's right-hand column shows a partial week and reads as a collapse.
   */
  it('aligns buckets to the end of the range and clips the oldest', () => {
    const buckets = evenBucketsIn(trailingWindow('2026-09-18', 20), 7);
    expect(buckets.at(-1)).toEqual({
      key: '2026-09-12',
      start: '2026-09-12',
      end: '2026-09-18',
    });
    expect(buckets[0]!.start).toBe('2026-08-30');
    expect(buckets).toHaveLength(3);
  });

  it('refuses a bucket shorter than a day', () => {
    expect(() => evenBucketsIn({ start: '2026-01-01', end: '2026-01-07' }, 0)).toThrow();
  });
});

describe('previousRange', () => {
  it('returns the window of equal length immediately before', () => {
    expect(previousRange({ start: '2026-06-21', end: '2026-09-18' })).toEqual({
      start: '2026-03-23',
      end: '2026-06-20',
    });
  });

  it('is exact for a single day', () => {
    expect(previousRange({ start: '2026-09-18', end: '2026-09-18' })).toEqual({
      start: '2026-09-17',
      end: '2026-09-17',
    });
  });
});

describe('bucketLabel', () => {
  it('labels months and days without drifting a timezone', () => {
    const bucket = { key: '2026-06', start: '2026-06-01', end: '2026-06-30' };
    expect(bucketLabel(bucket, 'month')).toBe('Jun');
    expect(bucketLabel(bucket, 'day')).toBe('Jun 1');
  });
});

describe('trailingMonths', () => {
  it('starts on the first of the earliest month, so the oldest bucket is whole', () => {
    expect(trailingMonths('2026-09-18', 12)).toEqual({
      start: '2025-10-01',
      end: '2026-09-18',
    });
  });

  it('is the current month alone for one month', () => {
    expect(trailingMonths('2026-09-18', 1)).toEqual({ start: '2026-09-01', end: '2026-09-18' });
  });

  it('refuses a window of no months', () => {
    expect(() => trailingMonths('2026-09-18', 0)).toThrow();
  });
});

describe('parseWallClock', () => {
  it('reads a zoneless timestamp as tenant-local, not server-local', () => {
    // Aloware's own format. 11:32 in New York during daylight time is 15:32Z;
    // parsed as UTC it would be four hours early and speed to lead would read
    // as four hours of neglect on every call.
    const d = parseWallClock('2026-06-19 11:32:04', 'America/New_York');
    expect(d?.toISOString()).toBe('2026-06-19T15:32:04.000Z');
  });

  it('follows the zone across a daylight-saving change', () => {
    // Eastern standard time in January is UTC-5, daylight time in June UTC-4.
    // A fixed offset would be wrong for one of these.
    expect(parseWallClock('2026-01-15 09:00:00', 'America/New_York')?.toISOString()).toBe(
      '2026-01-15T14:00:00.000Z',
    );
    expect(parseWallClock('2026-06-15 09:00:00', 'America/New_York')?.toISOString()).toBe(
      '2026-06-15T13:00:00.000Z',
    );
  });

  it('handles the hour either side of the spring transition', () => {
    // 2026-03-08 02:30 does not exist in New York. It must still resolve to a
    // real instant rather than to NaN or to an hour in the wrong offset.
    const d = parseWallClock('2026-03-08 02:30:00', 'America/New_York');
    expect(d).not.toBeNull();
    expect(Number.isNaN(d!.getTime())).toBe(false);
  });

  it('accepts the ISO T separator and an absent seconds field', () => {
    expect(parseWallClock('2026-06-19T11:32', 'America/New_York')?.toISOString()).toBe(
      '2026-06-19T15:32:00.000Z',
    );
  });

  it('returns null for anything that is not a wall clock', () => {
    for (const text of ['', 'yesterday', '19/06/2026', 'null']) {
      expect(parseWallClock(text, 'America/New_York')).toBeNull();
    }
  });

  it('is the identity for UTC', () => {
    expect(parseWallClock('2026-06-19 11:32:04', 'UTC')?.toISOString()).toBe(
      '2026-06-19T11:32:04.000Z',
    );
  });
});
