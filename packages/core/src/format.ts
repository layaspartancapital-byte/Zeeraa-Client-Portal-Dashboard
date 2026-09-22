/**
 * Number presentation rules (§12).
 *
 * These live here rather than in components so that the same value formats
 * identically on the executive view, the monthly table, the CSV export and the
 * print sheet. Formatting drift between screens reads as a data problem.
 */

export type ImprovementDirection = 'up' | 'down';

/**
 * Currency rule: no decimals above $1,000, two below — and never mixed within a
 * column. So the decision is made once for a whole column of values, not per
 * value. Pass the column; get a formatter.
 */
export function currencyFormatterFor(
  values: readonly number[],
  currency = 'USD',
  locale = 'en-US',
): (value: number) => string {
  const largest = values.reduce((max, v) => (Math.abs(v) > max ? Math.abs(v) : max), 0);
  const decimals = largest >= 1000 ? 0 : 2;
  const fmt = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return (value: number) => fmt.format(value);
}

/** Single figure outside a column context (e.g. the north-star number). */
export function formatCurrency(value: number, currency = 'USD', locale = 'en-US'): string {
  return currencyFormatterFor([value], currency, locale)(value);
}

/** Rates carry one decimal. The denominator goes in the sub-label, not here. */
export function formatRate(rate: number, locale = 'en-US'): string {
  return `${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(rate * 100)}%`;
}

/** `14.7% · 31 of 211` — the referent requirement from §12. */
export function formatRateWithDenominator(
  numerator: number,
  denominator: number,
  locale = 'en-US',
): string {
  if (denominator === 0) return '—';
  return `${formatRate(numerator / denominator, locale)} · ${formatCount(
    numerator,
    locale,
  )} of ${formatCount(denominator, locale)}`;
}

/**
 * Never render a raw platform float. Google Ads reports 622.86 conversions
 * because of fractional attribution; the fraction is explained in the metric
 * definition, not shown in the cell.
 */
export function formatCount(value: number, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(value));
}

/**
 * A projected count, which is allowed a fraction.
 *
 * `formatCount` rounds, because a count of things is a whole number and a cell
 * reading "7.5 deals" would be a measurement claiming something impossible. A
 * *contracted projection* is the opposite case: the model says month one buys
 * 7.5 funded deals at the contracted budget and cost per deal, and rendering
 * that as 8 restates the contract — $30,000 over 8 is $3,750, against a target
 * of $4,000.
 *
 * So the two have different functions rather than one function with a flag, and
 * the name says which kind of number is being shown. A whole projection still
 * renders whole: 40 approvals is "40", not "40.0".
 */
export function formatProjection(value: number, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatDays(value: number, locale = 'en-US'): string {
  const n = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
  return `${n} ${value === 1 ? 'day' : 'days'}`;
}

export type Delta = {
  /** Signed absolute change. */
  absolute: number;
  /** Signed proportional change, or null when the baseline is zero. */
  relative: number | null;
  /** Always explicit — positive and negative are never carried by colour alone. */
  sign: '+' | '−' | '±';
  /** Derived from the metric's improvement_direction. Never "up is green". */
  assessment: 'ahead' | 'shortfall' | 'level';
};

export function delta(
  current: number,
  baseline: number,
  improvementDirection: ImprovementDirection,
): Delta {
  const absolute = current - baseline;
  const relative = baseline === 0 ? null : absolute / baseline;
  const sign: Delta['sign'] = absolute > 0 ? '+' : absolute < 0 ? '−' : '±';
  let assessment: Delta['assessment'] = 'level';
  if (absolute !== 0) {
    const improved = improvementDirection === 'up' ? absolute > 0 : absolute < 0;
    assessment = improved ? 'ahead' : 'shortfall';
  }
  return { absolute, relative, sign, assessment };
}

/** `+12.4%` / `−8.1%` / `±0%`. The sign is part of the string, always. */
export function formatDelta(d: Delta, locale = 'en-US'): string {
  if (d.relative === null) return d.sign === '±' ? '±0%' : `${d.sign}—`;
  const pct = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(Math.abs(d.relative) * 100);
  return d.sign === '±' ? '±0%' : `${d.sign}${pct}%`;
}
