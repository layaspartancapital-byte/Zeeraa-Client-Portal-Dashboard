import { describe, expect, it } from 'vitest';
import { rangeCoverage } from '../src';

describe('rangeCoverage', () => {
  const sep = { start: '2026-09-01', end: '2026-09-23' };

  it('is full when the last sync reaches the end of the range', () => {
    expect(rangeCoverage(sep, '2026-09-23').state).toBe('full');
    expect(rangeCoverage(sep, '2026-09-30').state).toBe('full');
  });

  it('is partial when the range runs past the last sync', () => {
    expect(rangeCoverage(sep, '2026-09-19')).toEqual({ state: 'partial', through: '2026-09-19' });
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
