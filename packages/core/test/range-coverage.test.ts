import { describe, expect, it } from 'vitest';
import { daySpans, rangeCoverage } from '../src';

describe('rangeCoverage', () => {
  const sep = { start: '2026-09-01', end: '2026-09-23' };

  it('is full when the last sync reaches the end of the range', () => {
    expect(rangeCoverage(sep, '2026-09-23').state).toBe('full');
    expect(rangeCoverage(sep, '2026-09-30').state).toBe('full');
  });

  it('is partial when the range runs past the last sync', () => {
    expect(rangeCoverage(sep, '2026-09-19')).toEqual({ state: 'partial', through: '2026-09-19', missing: [], pastThrough: true });
  });

  it('is none when the range begins after the last sync — never a zero', () => {
    expect(rangeCoverage({ start: '2026-09-22', end: '2026-09-22' }, '2026-09-19').state).toBe('none');
  });

  it('counts the day of the last sync as synced', () => {
    expect(rangeCoverage({ start: '2026-09-19', end: '2026-09-19' }, '2026-09-19').state).toBe('full');
  });

  it('is never for a source that has not delivered', () => {
    expect(rangeCoverage(sep, null).state).toBe('never');
  });
});

describe('rangeCoverage with unread days', () => {
  const sep = { start: '2026-09-01', end: '2026-09-22' };

  it('is partial when days inside the record were never read', () => {
    // Meta, September 2026: synced before and after, 19–20 never read.
    expect(rangeCoverage(sep, '2026-09-23', ['2026-09-19', '2026-09-20'])).toEqual({
      state: 'partial',
      through: '2026-09-23',
      missing: ['2026-09-19', '2026-09-20'],
      pastThrough: false,
    });
  });

  it('is none when every day of the range is unread, not a zero', () => {
    expect(
      rangeCoverage({ start: '2026-09-19', end: '2026-09-20' }, '2026-09-23', ['2026-09-19', '2026-09-20']).state,
    ).toBe('none');
  });

  it('ignores unread days outside the range', () => {
    expect(rangeCoverage({ start: '2026-09-01', end: '2026-09-15' }, '2026-09-23', ['2026-09-19']).state).toBe('full');
  });

  it('only counts unread days up to the last read', () => {
    const c = rangeCoverage(sep, '2026-09-20', ['2026-09-19', '2026-09-21']);
    expect(c.missing).toEqual(['2026-09-19']);
    expect(c.state).toBe('partial');
  });
});

describe('daySpans', () => {
  it('joins consecutive days into one span', () => {
    expect(daySpans(['2026-09-20', '2026-09-19', '2026-09-23'])).toEqual([
      { start: '2026-09-19', end: '2026-09-20' },
      { start: '2026-09-23', end: '2026-09-23' },
    ]);
  });

  it('crosses a month boundary', () => {
    expect(daySpans(['2026-08-31', '2026-09-01'])).toEqual([{ start: '2026-08-31', end: '2026-09-01' }]);
  });
});
