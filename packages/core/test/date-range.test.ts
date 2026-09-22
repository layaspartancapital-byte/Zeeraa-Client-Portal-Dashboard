import { describe, expect, it } from 'vitest';
import {
  formatRangeLabel,
  granularityFor,
  isDay,
  matchPreset,
  MAX_RANGE_DAYS,
  precedingRange,
  presetRange,
  rangeLengthDays,
  resolveDateRange,
  RANGE_PRESETS,
} from '../src/date-range';

const TODAY = '2026-09-21';
const EARLIEST = '2026-06-20';

describe('isDay', () => {
  it('accepts a real day', () => {
    expect(isDay('2026-09-21')).toBe(true);
  });

  it('rejects the right shape with an impossible date', () => {
    // The check that regex alone does not make: February has no 31st, and
    // `new Date` would roll it into March rather than refusing.
    expect(isDay('2026-02-31')).toBe(false);
    expect(isDay('2026-13-01')).toBe(false);
    expect(isDay('2026-00-10')).toBe(false);
  });

  it('rejects anything else', () => {
    for (const value of ['', '21/09/2026', '2026-9-1', 'yesterday', null, undefined]) {
      expect(isDay(value as string)).toBe(false);
    }
  });
});

describe('presetRange', () => {
  it('resolves each preset against the tenant’s today', () => {
    expect(presetRange('today', TODAY, EARLIEST)).toEqual({ start: TODAY, end: TODAY });
    expect(presetRange('7d', TODAY, EARLIEST)).toEqual({ start: '2026-09-15', end: TODAY });
    expect(presetRange('30d', TODAY, EARLIEST)).toEqual({ start: '2026-08-23', end: TODAY });
    expect(presetRange('90d', TODAY, EARLIEST)).toEqual({ start: '2026-06-24', end: TODAY });
    expect(presetRange('mtd', TODAY, EARLIEST)).toEqual({ start: '2026-09-01', end: TODAY });
  });

  it('starts "all time" at the first ingested day', () => {
    expect(presetRange('all', TODAY, EARLIEST)).toEqual({ start: EARLIEST, end: TODAY });
  });

  it('falls back rather than inventing a start when nothing is ingested', () => {
    // A range beginning at the epoch would draw sixty years of nothing.
    expect(presetRange('all', TODAY, null)).toEqual(presetRange('90d', TODAY, null));
  });

  it('includes both ends — 7d is seven days, not eight', () => {
    expect(rangeLengthDays(presetRange('7d', TODAY, EARLIEST))).toBe(7);
    expect(rangeLengthDays(presetRange('30d', TODAY, EARLIEST))).toBe(30);
    expect(rangeLengthDays(presetRange('today', TODAY, EARLIEST))).toBe(1);
  });
});

describe('matchPreset', () => {
  it('recognises a range that is exactly a preset', () => {
    for (const { key } of RANGE_PRESETS) {
      const range = presetRange(key, TODAY, EARLIEST);
      expect(matchPreset(range, TODAY, EARLIEST)).toBe(key);
    }
  });

  it('returns null for a range that is not one', () => {
    expect(matchPreset({ start: '2026-08-01', end: '2026-08-31' }, TODAY, EARLIEST)).toBeNull();
  });
});

describe('resolveDateRange', () => {
  const base = { today: TODAY, earliest: EARLIEST };

  it('defaults to the 90 days the old control opened on', () => {
    const r = resolveDateRange(base);
    expect(r.range).toEqual(presetRange('90d', TODAY, EARLIEST));
    expect(r.preset).toBe('90d');
    expect(r.problem).toBeNull();
  });

  it('takes an explicit pair of dates', () => {
    const r = resolveDateRange({ ...base, from: '2026-08-01', to: '2026-08-31' });
    expect(r.range).toEqual({ start: '2026-08-01', end: '2026-08-31' });
    expect(r.preset).toBeNull();
    expect(r.problem).toBeNull();
  });

  it('labels an explicit pair that happens to be a preset', () => {
    const ninety = presetRange('90d', TODAY, EARLIEST);
    const r = resolveDateRange({ ...base, from: ninety.start, to: ninety.end });
    expect(r.preset).toBe('90d');
  });

  it('accepts a single day', () => {
    const r = resolveDateRange({ ...base, from: '2026-08-04', to: '2026-08-04' });
    expect(r.range).toEqual({ start: '2026-08-04', end: '2026-08-04' });
    expect(r.problem).toBeNull();
  });

  it('refuses a reversed pair rather than deciding what was meant', () => {
    // Swapping would guess. Two dates the wrong way round is as likely to be
    // the wrong field filled in as a transposition.
    const r = resolveDateRange({ ...base, from: '2026-09-01', to: '2026-08-01' });
    expect(r.range).toEqual(presetRange('90d', TODAY, EARLIEST));
    expect(r.problem).toMatch(/after the end date/);
  });

  it('refuses half a pair, and says so', () => {
    expect(resolveDateRange({ ...base, from: '2026-08-01' }).problem).toMatch(/pair of dates/);
    expect(resolveDateRange({ ...base, to: '2026-08-01' }).problem).toMatch(/pair of dates/);
  });

  it('refuses an unparseable date', () => {
    expect(resolveDateRange({ ...base, from: 'August', to: TODAY }).problem).toMatch(/pair of dates/);
    expect(resolveDateRange({ ...base, from: '2026-02-31', to: TODAY }).problem).toMatch(/pair of dates/);
  });

  it('refuses an absurd span rather than querying a decade', () => {
    const r = resolveDateRange({ ...base, from: '2016-01-01', to: TODAY });
    expect(r.problem).toMatch(/not drawn/);
    expect(r.range).toEqual(presetRange('90d', TODAY, EARLIEST));
  });

  it('allows a span right up to the limit', () => {
    const from = '2024-01-01';
    const to = '2026-12-31';
    const length = rangeLengthDays({ start: from, end: to });
    expect(length).toBeLessThanOrEqual(MAX_RANGE_DAYS);
    expect(resolveDateRange({ ...base, from, to }).problem).toBeNull();
  });

  it('takes a preset by name', () => {
    const r = resolveDateRange({ ...base, preset: 'mtd' });
    expect(r.range).toEqual(presetRange('mtd', TODAY, EARLIEST));
    expect(r.preset).toBe('mtd');
  });

  it('prefers explicit dates over a preset', () => {
    const r = resolveDateRange({ ...base, preset: 'today', from: '2026-08-01', to: '2026-08-31' });
    expect(r.range).toEqual({ start: '2026-08-01', end: '2026-08-31' });
  });

  it('still honours a link made before this existed', () => {
    // A bookmark or a saved CSV URL carrying ?days=30 must keep meaning 30 days
    // rather than silently resolving to something else.
    const r = resolveDateRange({ ...base, days: '30' });
    expect(r.range).toEqual(presetRange('30d', TODAY, EARLIEST));
    expect(r.preset).toBe('30d');
  });

  it('ignores a nonsense legacy value', () => {
    for (const days of ['0', '-5', 'lots', '100000']) {
      expect(resolveDateRange({ ...base, days }).range).toEqual(presetRange('90d', TODAY, EARLIEST));
    }
  });

  it('never returns a range whose start is after its end', () => {
    const inputs = [
      { from: '2026-09-01', to: '2026-08-01' },
      { from: 'nonsense', to: 'nonsense' },
      { days: '-1' },
      { preset: 'all' },
      {},
    ];
    for (const input of inputs) {
      const { range } = resolveDateRange({ ...base, ...input });
      expect(range.start <= range.end).toBe(true);
    }
  });
});

describe('formatRangeLabel', () => {
  it('states the year once when both ends share it, in the app’s own locale', () => {
    expect(formatRangeLabel({ start: '2026-06-21', end: '2026-09-21' })).toBe(
      'Jun 21 – Sep 21, 2026',
    );
  });

  it('states both years when they differ', () => {
    expect(formatRangeLabel({ start: '2025-12-21', end: '2026-09-21' })).toBe(
      'Dec 21, 2025 – Sep 21, 2026',
    );
  });

  it('collapses a single day to one date', () => {
    expect(formatRangeLabel({ start: '2026-09-21', end: '2026-09-21' })).toBe('Sep 21, 2026');
  });
});

describe('granularityFor', () => {
  it('draws a long range in months, a medium one in weeks and a short one in days', () => {
    expect(granularityFor({ start: '2026-06-24', end: '2026-09-21' })).toBe('month');
    expect(granularityFor({ start: '2026-08-23', end: '2026-09-21' })).toBe('week');
    expect(granularityFor({ start: '2026-09-15', end: '2026-09-21' })).toBe('day');
  });

  it('resolves a single day to one day bucket rather than to a week of one', () => {
    // The executive screen leads with activity on a range this short, and a
    // day's figures drawn as a single week-wide column is a column labelled
    // with the wrong period.
    expect(granularityFor({ start: '2026-09-21', end: '2026-09-21' })).toBe('day');
  });

  it('turns at three weeks and at ten', () => {
    // Exactly at each boundary, because an off-by-one here is invisible: a
    // 21-day range drawn in days is three legible columns either way.
    expect(granularityFor({ start: '2026-09-01', end: '2026-09-21' })).toBe('week');
    expect(granularityFor({ start: '2026-09-02', end: '2026-09-21' })).toBe('day');
    expect(granularityFor({ start: '2026-07-14', end: '2026-09-21' })).toBe('month');
    expect(granularityFor({ start: '2026-07-15', end: '2026-09-21' })).toBe('week');
  });
});

describe('precedingRange', () => {
  it('is the same length, ending the day before', () => {
    const range = { start: '2026-09-01', end: '2026-09-30' };
    expect(precedingRange(range)).toEqual({ start: '2026-08-02', end: '2026-08-31' });
    expect(rangeLengthDays(precedingRange(range))).toBe(rangeLengthDays(range));
  });
});
