import { formatCount, formatRate } from '@zeeraa/core';

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
