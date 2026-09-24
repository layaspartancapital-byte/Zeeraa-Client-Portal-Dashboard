import { formatCount, formatProjection, formatRate, formatTargetCurrency } from '@zeeraa/core';

/**
 * How a chart axis, label and tooltip format their numbers.
 *
 * A descriptor rather than a function, because the charts are client components
 * and the pages that configure them are server components: a formatter cannot
 * cross that boundary, and the alternative — every chart hard-coding currency
 * and precision — is how two panels on one screen end up disagreeing about
 * whether a figure has decimals.
 *
 * The rules themselves stay in `@zeeraa/core`, so a value formats identically
 * on a chart axis, in a table cell, in the CSV export and on the print sheet.
 */
export type FormatSpec =
  | { kind: 'currency'; currency: string }
  | { kind: 'count' }
  /** A contracted projection, which may be a fraction: 7.5 funded deals. */
  | { kind: 'projection' }
  /** A proportion in 0–1, rendered as a percentage. */
  | { kind: 'rate' }
  /** Already a percentage, e.g. a change of −8.1. */
  | { kind: 'percentPoints' };

export function formatter(spec: FormatSpec): (value: number) => string {
  switch (spec.kind) {
    case 'currency': {
      // No decimals on a chart axis: the gridline labels are the one place a
      // cent is never the question being asked.
      const fmt = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: spec.currency,
        maximumFractionDigits: 0,
      });
      return (value) => fmt.format(value);
    }
    case 'count':
      return (value) => formatCount(value);
    case 'projection':
      return (value) => formatProjection(value);
    case 'rate':
      return (value) => formatRate(value);
    case 'percentPoints':
      return (value) =>
        `${new Intl.NumberFormat('en-US', {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }).format(value)}%`;
  }
}

/**
 * The same values, short enough for a y-axis tick: `$320K`, `$1.2M`, `600`.
 *
 * Only for the axis. A 56-pixel gutter clips `$1,200,000` to `200,000`, which
 * reads as a different number, and a clipped number is worse than a rounded
 * one. The tooltip and the figures under the chart keep the full value.
 */
/**
 * How a contracted target is written: as `formatter`, but whole dollars for
 * money (`formatTargetCurrency`).
 */
export function targetFormatter(spec: FormatSpec): (value: number) => string {
  if (spec.kind === 'currency') {
    const { currency } = spec;
    return (value) => formatTargetCurrency(value, currency);
  }
  return formatter(spec);
}

export function axisFormatter(spec: FormatSpec): (value: number) => string {
  const full = formatter(spec);
  if (spec.kind !== 'currency' && spec.kind !== 'count' && spec.kind !== 'projection') return full;
  const compact = new Intl.NumberFormat('en-US', {
    ...(spec.kind === 'currency' ? { style: 'currency', currency: spec.currency } : {}),
    notation: 'compact',
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
  return (value) => (Math.abs(value) >= 10_000 ? compact.format(value) : full(value));
}
