import {
  judgeBand,
  readDurationBand,
  readMoneyBand,
  type QualificationBar,
} from '@zeeraa/core';
import { timeInBusinessCandidates, type SalesforceFieldMapping } from './mapping';
import type { SalesforceRecord } from './sync';

/**
 * The qualification bar, evaluated against the bands a lead actually carries.
 *
 * The bar is two numeric thresholds. The answers are not numeric: they are
 * picklist labels and free text in several vocabularies, and 69% of inbound
 * leads carry both inputs in some form while none carry both as a figure. So
 * each input is read from an ordered list of candidate fields and judged as an
 * interval, and the verdict — not a number — is what travels.
 *
 * What this deliberately does not do is resolve a band to one of its bounds and
 * hand that on as revenue. The bound would reproduce the verdict correctly and
 * then be read as the merchant's revenue by anything that bands leads by it.
 */

export type BandVerdictDetail = {
  verdict: 'qualified' | 'unqualified' | 'undeterminable';
  /** Set when `undeterminable`, naming the input and the obstruction. */
  reason: string | null;
  /** Which field answered each half, for the audit trail. */
  revenueField: string | null;
  durationField: string | null;
};

type Half = { meets: boolean | null; field: string | null; why: string | null };

const value = (record: SalesforceRecord, field: string): string | null => {
  const raw = record[field];
  if (raw == null) return null;
  const text = String(raw).trim();
  return text === '' ? null : text;
};

/**
 * The first *resolvable* reading across the candidates.
 *
 * Ordered by population, but a straddling band does not win simply by being
 * first: it is remembered as the fallback and the next field is tried. Only if
 * nothing resolves does the straddle become the answer, which is why 87% of
 * the population resolves on revenue when the best single field covers 50%.
 */
function firstResolvable(
  record: SalesforceRecord,
  candidates: readonly { field: string; read: (raw: string) => boolean | null; why: (raw: string) => string }[],
): Half {
  let fallback: Half | null = null;
  for (const candidate of candidates) {
    const raw = value(record, candidate.field);
    if (raw == null) continue;
    const meets = candidate.read(raw);
    if (meets !== null) return { meets, field: candidate.field, why: null };
    fallback ??= { meets: null, field: candidate.field, why: candidate.why(raw) };
  }
  return fallback ?? { meets: null, field: null, why: null };
}

export function judgeQualificationBands(
  record: SalesforceRecord,
  mapping: SalesforceFieldMapping,
  bar: QualificationBar,
): BandVerdictDetail {
  const revenue = firstResolvable(
    record,
    (mapping.lead.revenueBands ?? []).map((c) => ({
      field: c.field,
      read: (raw: string) => judgeBand(readMoneyBand(raw, c.period), bar.minMonthlyRevenue).meets,
      why: (raw: string) => {
        const { reason } = judgeBand(readMoneyBand(raw, c.period), bar.minMonthlyRevenue);
        return reason === 'straddles'
          ? `revenue is recorded as "${raw}", which spans the $${bar.minMonthlyRevenue.toLocaleString('en-US')} bar`
          : reason === 'categorical'
            ? `revenue is recorded as "${raw}", which is not an amount`
            : `revenue is recorded as "${raw}", which could not be read as an amount`;
      },
    })),
  );

  const duration = firstResolvable(
    record,
    timeInBusinessCandidates(mapping).map((c) => ({
      field: c.field,
      // A business that has not started trading has no trading history, so it
      // fails a minimum duration outright. Stated here rather than inside the
      // parser, because the same label against a revenue minimum means nothing.
      //
      // `c.unit` says what a bare number in *this field* means. Without it a
      // `3` in `Years_In_Business_Text__c` read as three months and failed the
      // bar, and a `1000` in a vendor's code field read as a thousand.
      read: (raw: string) =>
        judgeBand(readDurationBand(raw, c.unit), bar.minMonthsInBusiness, false).meets,
      why: (raw: string) => {
        const { reason } = judgeBand(readDurationBand(raw, c.unit), bar.minMonthsInBusiness, false);
        return reason === 'straddles'
          ? `time in business is recorded as "${raw}", which spans ${bar.minMonthsInBusiness} months`
          : `time in business is recorded as "${raw}", which could not be read as a duration`;
      },
    })),
  );

  const detail = { revenueField: revenue.field, durationField: duration.field };

  // A definite failure outranks an unreadable other half: a lead that fails one
  // condition is unqualified whatever the second condition would have said.
  if (revenue.meets === false || duration.meets === false) {
    return { verdict: 'unqualified', reason: null, ...detail };
  }
  if (revenue.meets === true && duration.meets === true) {
    return { verdict: 'qualified', reason: null, ...detail };
  }

  const undecodable = mapping.lead.undecodableFields ?? [];
  const blocked = undecodable.filter((u) => value(record, u.field) != null);
  const reasons = [
    revenue.meets === null
      ? (revenue.why ?? 'no revenue answer of any kind is recorded')
      : null,
    duration.meets === null
      ? (duration.why ??
        (blocked.length > 0
          ? `the only time-in-business answer is ${blocked.map((b) => b.field).join(', ')}, which cannot be decoded`
          : 'no time-in-business answer of any kind is recorded'))
      : null,
  ].filter((r): r is string => r != null);

  return { verdict: 'undeterminable', reason: reasons.join('; '), ...detail };
}
