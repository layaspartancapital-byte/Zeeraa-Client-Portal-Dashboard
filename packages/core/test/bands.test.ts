import { describe, expect, it } from 'vitest';
import { judgeBand, readDurationBand, readMoneyBand, rangeMeetsMinimum } from '../src/bands';

/**
 * Every literal here is a value that exists in Spartan's org today, taken from
 * the field inventory rather than invented. The bar is $10,000 monthly revenue
 * and 12 months in business.
 */
const BAR = 10_000;
const MONTHS = 12;
const money = (raw: string, period: 'monthly' | 'annual' = 'monthly') =>
  judgeBand(readMoneyBand(raw, period), BAR);
const duration = (raw: string, categoricalMeans: boolean | null = null) =>
  judgeBand(readDurationBand(raw), MONTHS, categoricalMeans);

describe('money bands against a $10,000 monthly bar', () => {
  it('resolves a band entirely at or above the bar', () => {
    for (const raw of ['$10,000 - $25,000', '$10,000 – $25,000', '$25K - $50K', '$250K+',
                       '$750,000 +', '$35K+', '$50,000 - $100,000', '$251,000 – $1 Million']) {
      expect(money(raw), raw).toEqual({ meets: true, reason: 'resolved' });
    }
  });

  it('resolves a band entirely below it', () => {
    // The bar is `>=`, so a value strictly under $10,000 fails cleanly. This is
    // the boundary that a `high < minimum` test gets wrong.
    for (const raw of ['< $10,000', 'Less than $10,000', '<  $10,000', '&lt; $10,000',
                       '$600-$700', '$5,000 - $9,000']) {
      expect(money(raw), raw).toEqual({ meets: false, reason: 'resolved' });
    }
  });

  it('refuses a band that contains the bar', () => {
    for (const raw of ['< $15,000', 'Less than $15,000', '$5,000 – $25,000', 'Menos de 15.000 dólares']) {
      expect(money(raw), raw).toEqual({ meets: null, reason: 'straddles' });
    }
  });

  it('carries a magnitude suffix back across a range', () => {
    // `10-25k` is $10k–$25k. Read as $10–$25,000 it straddles the bar, which is
    // how 14 leads were being reported undeterminable when they clear it.
    expect(readMoneyBand('10-25k', 'monthly')).toEqual({
      kind: 'range',
      range: { low: 10_000, high: 25_000, highExclusive: false },
    });
    expect(money('10-25k')).toEqual({ meets: true, reason: 'resolved' });
    // …but an already-plausible magnitude is left alone.
    expect(readMoneyBand('$10,000 - $25K', 'monthly')).toEqual({
      kind: 'range',
      range: { low: 10_000, high: 25_000, highExclusive: false },
    });
  });

  it('reads an annual field into monthly before comparing', () => {
    // $180,000 a year is $15,000 a month, which straddles a $10,000 bar just as
    // its monthly twin does.
    expect(money('Less than $180,000', 'annual')).toEqual({ meets: null, reason: 'straddles' });
    expect(money('120000', 'annual')).toEqual({ meets: true, reason: 'resolved' });
    expect(money('96000', 'annual')).toEqual({ meets: false, reason: 'resolved' });
  });

  it('treats a bare figure as itself', () => {
    expect(money('25000')).toEqual({ meets: true, reason: 'resolved' });
    expect(money('8000')).toEqual({ meets: false, reason: 'resolved' });
  });

  it('does not read a category as a quantity', () => {
    for (const raw of ['New Business', 'Not Started', 'Not_Started']) {
      expect(money(raw), raw).toEqual({ meets: null, reason: 'categorical' });
    }
  });
});

describe('duration bands against 12 months', () => {
  it('converts years to months from the label', () => {
    expect(readDurationBand('1 - 3 Years').kind).toBe('range');
    for (const raw of ['1 - 3 Years', '3 - 5 Years', '5+ Years', '10+ Years', '12 Months +',
                       '1 - 2 Years', '1-2 Years', '6 - 10 Years']) {
      expect(duration(raw), raw).toEqual({ meets: true, reason: 'resolved' });
    }
  });

  it('resolves durations entirely under a year', () => {
    for (const raw of ['< 12 Months', 'Under 12 Months', '<12 Months', 'Less than 6 months']) {
      expect(duration(raw), raw).toEqual({ meets: false, reason: 'resolved' });
    }
  });

  it('refuses a band that contains twelve months', () => {
    // `0 - 1 Years` admits 3 months and 11 months as readily as 12.
    for (const raw of ['0 - 1 Years', '0-1 Years']) {
      expect(duration(raw), raw).toEqual({ meets: null, reason: 'straddles' });
    }
  });

  it('reads the underscored picklist API forms', () => {
    expect(duration('x12_Months_plus')).toEqual({ meets: true, reason: 'resolved' });
    expect(duration('x12_Months')).toEqual({ meets: true, reason: 'resolved' });
  });

  it('lets the caller say what a no-trading-history label means', () => {
    // Against a *duration* minimum, a business that has not started has no
    // trading history and fails. Against revenue it means nothing, which is
    // why the caller decides rather than this module.
    expect(duration('Not Started', false)).toEqual({ meets: false, reason: 'resolved' });
    expect(duration('New Business', false)).toEqual({ meets: false, reason: 'resolved' });
    expect(duration('Not Started')).toEqual({ meets: null, reason: 'categorical' });
  });
});

describe('rangeMeetsMinimum', () => {
  it('is null for a range unbounded on the wrong side of the minimum', () => {
    expect(rangeMeetsMinimum({ low: null, high: 20_000, highExclusive: true }, 10_000)).toBeNull();
    expect(rangeMeetsMinimum({ low: 5_000, high: null, highExclusive: false }, 10_000)).toBeNull();
  });

  it('handles the exclusive upper bound at the boundary', () => {
    expect(rangeMeetsMinimum({ low: null, high: 10_000, highExclusive: true }, 10_000)).toBe(false);
    expect(rangeMeetsMinimum({ low: null, high: 10_000, highExclusive: false }, 10_000)).toBeNull();
  });
});

/**
 * The unit a bare number carries, and the guard that stops a code becoming one.
 *
 * Every value below was taken from Spartan's org on 22 September 2026 while
 * enumerating every field across all 760 queryable objects that mentions
 * revenue or time in business.
 */
describe('readDurationBand and the declared unit', () => {
  it('refuses a bare number in a labelled field', () => {
    // `MIYB_Years_in_Business__c` and `MIRV_Volume_Code__c` both hold these on
    // thousands of leads. Read as months, `1000` cleared a twelve-month bar and
    // qualified the lead — silently, because the arithmetic is fine.
    for (const code of ['0000', '1000', '1100', '1110', '1111']) {
      expect(readDurationBand(code, 'labelled')).toEqual({ kind: 'unreadable' });
      expect(judgeBand(readDurationBand(code, 'labelled'), 12).meets).toBeNull();
    }
  });

  it('reads a bare number in a field that declares years', () => {
    // `Years_In_Business_Text__c` holds bare 3, 4, 5 meaning years beside
    // `< 12 Months` meaning months. Read as months, a three-year-old business
    // failed the twelve-month bar.
    expect(judgeBand(readDurationBand('3', 'years'), 12).meets).toBe(true);
    expect(readDurationBand('3', 'years')).toEqual({
      kind: 'range',
      range: { low: 36, high: 36, highExclusive: false },
    });
    // Read as months it is three months, which is the bug.
    expect(judgeBand(readDurationBand('3', 'months'), 12).meets).toBe(false);
  });

  it('lets the value overrule the field, because one picklist mixes both', () => {
    // The same field holds both, so a per-field unit alone cannot read it.
    expect(judgeBand(readDurationBand('< 12 Months', 'years'), 12).meets).toBe(false);
    expect(judgeBand(readDurationBand('5+ Years', 'months'), 12).meets).toBe(true);
    expect(judgeBand(readDurationBand('12 Months +', 'years'), 12).meets).toBe(true);
  });

  it('defaults to labelled, so an undeclared field cannot invent a duration', () => {
    expect(readDurationBand('1000')).toEqual({ kind: 'unreadable' });
    expect(judgeBand(readDurationBand('1 - 3 Years'), 12).meets).toBe(true);
  });

  it('reads Spanish units rather than guessing months', () => {
    // `1 - 3 años` used to read as one to three *months* and fail the bar.
    expect(judgeBand(readDurationBand('1 - 3 años', 'labelled'), 12).meets).toBe(true);
  });

  it('still straddles where the band contains the bar', () => {
    expect(judgeBand(readDurationBand('0 - 1 Years', 'labelled'), 12).meets).toBeNull();
    expect(judgeBand(readDurationBand('0 - 1 Years', 'labelled'), 12).reason).toBe('straddles');
  });

  it('leaves money alone, because a bare amount there is genuine', () => {
    // `Monthly_Revenue_Text__c` holds `25000` and `75000` on 627 leads. The
    // same guard would discard them, which is why a revenue code field has to
    // be excluded by name instead.
    expect(judgeBand(readMoneyBand('25000', 'monthly'), 10_000).meets).toBe(true);
    expect(judgeBand(readMoneyBand('$10,000 - $20,000', 'monthly'), 10_000).meets).toBe(true);
  });
});
