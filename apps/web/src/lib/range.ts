import 'server-only';
import {
  resolveDateRange,
  tenantDay,
  type DateRange,
  type RangePresetKey,
} from '@zeeraa/core';
import { type Ingestion } from '@/lib/dashboard';
import type { TenantSession } from '@/lib/tenant';
import { ingestionStart } from '@/lib/cached-reports';

/**
 * The page's date range, resolved once per screen and identically on each.
 *
 * Five screens read `?from=&to=`, and the one thing they must not do is
 * disagree about what it means. This is also where the earliest ingested day
 * comes from, which "All time" needs and which the picker states beneath the
 * range — a start before it is allowed, and renders as "not ingested before …"
 * rather than as zeros.
 *
 * It returns the `Ingestion` it fetched so the caller does not query for it
 * again: every page needs it anyway, to decide whether a comparison against the
 * preceding period is a comparison at all.
 */
export type PageRange = {
  range: DateRange;
  preset: RangePresetKey | null;
  problem: string | null;
  today: string;
  /** First day anything was ingested, across paid media and the CRM. */
  earliest: string | null;
  ingestion: Ingestion;
};

export type RangeQuery = {
  from?: string;
  to?: string;
  preset?: string;
  /** Read only so that links made before the picker existed keep working. */
  days?: string;
};

export async function resolvePageRange(
  session: TenantSession,
  query: RangeQuery,
): Promise<PageRange> {
  const today = tenantDay(new Date(), session.tenant.timezone);
  const ingestion = await ingestionStart(session);
  const earliest =
    [ingestion.spendFrom, ingestion.crmFrom].filter((d): d is string => Boolean(d)).sort()[0] ??
    null;

  const { range, preset, problem } = resolveDateRange({
    from: query.from,
    to: query.to,
    preset: query.preset,
    days: query.days,
    today,
    earliest,
  });

  return { range, preset, problem, today, earliest, ingestion };
}

/**
 * The links the picker needs: the params to carry through the form, and the
 * href for each preset.
 *
 * `others` is everything the page filters by apart from the range. A preset
 * link carries them and sets `preset=`, and carries **no** `from`/`to` — an
 * explicit pair beats a preset in the resolver, so leaving them would pin the
 * range to whatever was selected before.
 */
export function rangeLinks(base: string, others: Record<string, string | undefined>) {
  const preserve = Object.fromEntries(
    Object.entries(others).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  return {
    preserve,
    presetHref: (key: RangePresetKey) =>
      `${base}?${new URLSearchParams({ ...preserve, preset: key }).toString()}`,
  };
}

/** The range as query params, for a CSV export link that matches the screen. */
export function rangeParams(range: DateRange): Record<string, string> {
  return { from: range.start, to: range.end };
}
