import { describe, expect, it } from 'vitest';
import {
  currencyFormatterFor,
  delta,
  formatCount,
  formatDelta,
  formatRate,
  formatRateWithDenominator,
} from '../src/format';
import { monthRange, previousMonth, tenantDay, trailingWindow } from '../src/dates';

describe('currency', () => {
  it('drops decimals above $1,000', () => {
    expect(currencyFormatterFor([67637.68])(67637.68)).toBe('$67,638');
  });

  it('keeps two decimals below $1,000', () => {
    expect(currencyFormatterFor([19.79])(19.79)).toBe('$19.79');
  });

  it('never mixes precision within one column', () => {
    const fmt = currencyFormatterFor([19.79, 67637.68]);
    expect(fmt(19.79)).toBe('$20');
    expect(fmt(67637.68)).toBe('$67,638');
  });
});

describe('rates', () => {
  it('renders one decimal', () => {
    expect(formatRate(0.147)).toBe('14.7%');
  });

  it('carries the denominator as a referent', () => {
    expect(formatRateWithDenominator(31, 211)).toBe('14.7% · 31 of 211');
  });

  it('renders an em dash rather than dividing by zero', () => {
    expect(formatRateWithDenominator(0, 0)).toBe('—');
  });
});

describe('counts', () => {
  it('never renders a raw platform float', () => {
    expect(formatCount(622.86)).toBe('623');
  });
});

describe('delta', () => {
  it('treats a falling cost per funded deal as ahead', () => {
    const d = delta(4500, 8000, 'down');
    expect(d.assessment).toBe('ahead');
    expect(formatDelta(d)).toBe('−43.8%');
  });

  it('treats falling funded volume as a shortfall', () => {
    const d = delta(80000, 100000, 'up');
    expect(d.assessment).toBe('shortfall');
    expect(d.sign).toBe('−');
  });

  it('reports level when nothing moved', () => {
    expect(delta(10, 10, 'up').assessment).toBe('level');
    expect(formatDelta(delta(10, 10, 'up'))).toBe('±0%');
  });

  it('survives a zero baseline', () => {
    const d = delta(5, 0, 'up');
    expect(d.relative).toBeNull();
    expect(formatDelta(d)).toBe('+—');
  });
});

describe('tenant dates', () => {
  it('assigns a late-evening ET instant to the local day, not the UTC day', () => {
    // 2026-06-01T02:30:00Z is still 31 May in New York.
    expect(tenantDay(new Date('2026-06-01T02:30:00Z'), 'America/New_York')).toBe('2026-05-31');
  });

  it('builds the trailing 90-day re-pull window inclusively', () => {
    expect(trailingWindow('2026-09-17', 90)).toEqual({ start: '2026-06-20', end: '2026-09-17' });
  });

  it('bounds a month', () => {
    expect(monthRange('2026-08')).toEqual({ start: '2026-08-01', end: '2026-08-31' });
    expect(monthRange('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });

  it('steps back across a year boundary', () => {
    expect(previousMonth('2026-01')).toBe('2025-12');
  });
});
