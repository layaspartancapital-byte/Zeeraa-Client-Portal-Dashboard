import 'server-only';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { schema } from '@zeeraa/db';
import {
  daySpans,
  eachDay,
  formatRangeLabel,
  rangeCoverage,
  tenantDay,
  type DateRange,
  type RangeCoverage,
} from '@zeeraa/core';
import { platformLabel } from '@/lib/platform-labels';
import { AD_PLATFORMS } from '@/lib/platforms';
import { queryTenant, type TenantSession } from '@/lib/tenant';

/**
 * How far each source has actually been read, as a tenant-local day.
 *
 * The one rule every screen applies with it: **a range after a source's last
 * read is not a quiet period.** Asked about a day Salesforce had not been read
 * for, every CRM figure came back 0 — no deals, no leads, no funnel — which is
 * a measurement claiming nothing happened. Each screen now asks this for the
 * sources behind each figure and renders `Not measured` where the answer is
 * `none`, never the zero.
 *
 * What "read" means differs by source, and deliberately:
 *
 *   * **Salesforce and the ad platforms**: the last *successful* sync. A quiet
 *     day writes no `daily_metrics` row, so the newest row would understate how
 *     far the platform has been read.
 *   * **GA4 and Search Console**: the newest day with a `total` row. Both
 *     publish days late — a sync this morning can hold nothing past three days
 *     ago — so the last sync would overstate how far the data reaches.
 *   * **Calls**: the newest call received. They are pushed, not pulled; past the
 *     newest one there is nothing to have read.
 *
 * **Where the day ledger exists, it decides** (`sync_days`, migration 0030):
 * the ad platforms, GA4, Search Console and calls record each day a pull or an
 * import actually covered. Their `through` is the newest day read, and the
 * days inside the record that were never read are `unread` — so a range with
 * a hole in it says which days are missing instead of drawing them as quiet.
 * Salesforce reads by change watermark, which is continuous by construction,
 * and keeps the last-successful-sync rule.
 */
export type SourcesThrough = {
  /** Keyed by platform: `salesforce`, `google_ads`, `ga4`, `call_tracking`, … */
  byPlatform: Record<string, string | null>;
  /** The connected ad platforms that report spend, for the spend total. */
  spendPlatforms: string[];
  /** Days inside each ledgered source's record that were never read, ascending. */
  unread: Record<string, string[]>;
  /** The first day each ledgered source's record covers. */
  from: Record<string, string | null>;
};

/** Sources whose coverage comes from the day ledger rather than the last run. */
const LEDGERED = ['google_ads', 'meta', 'microsoft_ads', 'linkedin_ads', 'ga4', 'search_console', 'call_tracking'];

export async function sourcesThrough(session: TenantSession): Promise<SourcesThrough> {
  const tz = session.tenant.timezone;
  return queryTenant(session, async (tx) => {
    const tenantId = session.tenant.id;
    const [connections, runs, [calls], [ga4], [gsc], spending, ledger] = await Promise.all([
      tx
        .select({ platform: schema.connections.platform, status: schema.connections.status })
        .from(schema.connections)
        .where(eq(schema.connections.tenantId, tenantId)),
      tx
        .select({
          platform: schema.syncRuns.platform,
          at: sql<string | Date | null>`max(${schema.syncRuns.finishedAt}) filter (where ${schema.syncRuns.status} = 'succeeded')`,
        })
        .from(schema.syncRuns)
        .where(and(eq(schema.syncRuns.tenantId, tenantId), isNotNull(schema.syncRuns.finishedAt)))
        .groupBy(schema.syncRuns.platform),
      tx
        .select({ day: sql<string | null>`max(${schema.calls.occurredOn})::text` })
        .from(schema.calls)
        .where(eq(schema.calls.tenantId, tenantId)),
      tx
        .select({ day: sql<string | null>`max(${schema.ga4Metrics.date})::text` })
        .from(schema.ga4Metrics)
        .where(and(eq(schema.ga4Metrics.tenantId, tenantId), eq(schema.ga4Metrics.dimension, 'total'))),
      tx
        .select({ day: sql<string | null>`max(${schema.searchConsoleMetrics.date})::text` })
        .from(schema.searchConsoleMetrics)
        .where(
          and(
            eq(schema.searchConsoleMetrics.tenantId, tenantId),
            eq(schema.searchConsoleMetrics.dimension, 'total'),
          ),
        ),
      tx
        .selectDistinct({ platform: schema.dailyMetrics.platform })
        .from(schema.dailyMetrics)
        .where(eq(schema.dailyMetrics.tenantId, tenantId)),
      tx
        .select({
          platform: schema.syncDays.platform,
          day: sql<string>`to_char(${schema.syncDays.day}, 'YYYY-MM-DD')`,
        })
        .from(schema.syncDays)
        .where(eq(schema.syncDays.tenantId, tenantId)),
    ]);

    // `max()` over a timestamptz arrives as text; coerce before `tenantDay`.
    const dayOf = (value: string | Date | null | undefined) => {
      if (!value) return null;
      const date = value instanceof Date ? value : new Date(value);
      return Number.isNaN(date.getTime()) ? null : tenantDay(date, tz);
    };

    const byPlatform: Record<string, string | null> = {};
    for (const run of runs) byPlatform[run.platform] = dayOf(run.at);
    byPlatform.call_tracking = calls?.day ?? null;
    byPlatform.ga4 = ga4?.day ?? null;
    byPlatform.search_console = gsc?.day ?? null;

    // The ledger overrides wherever it has rows: newest day read, and the
    // days inside the record nobody read. A source with no ledger rows yet
    // keeps the rule above, so the change cannot blank a screen on deploy.
    const unread: Record<string, string[]> = {};
    const from: Record<string, string | null> = {};
    const readDays = new Map<string, Set<string>>();
    for (const row of ledger) {
      if (!LEDGERED.includes(row.platform)) continue;
      const set = readDays.get(row.platform) ?? readDays.set(row.platform, new Set()).get(row.platform)!;
      set.add(row.day);
    }
    for (const [platform, days] of readDays) {
      const sorted = [...days].sort();
      const first = sorted[0]!;
      const last = sorted.at(-1)!;
      from[platform] = first;
      byPlatform[platform] = last;
      unread[platform] = eachDay({ start: first, end: last }).filter((d) => !days.has(d));
    }

    const connected = new Set(
      connections.filter((c) => c.status !== 'not_configured').map((c) => c.platform),
    );
    const spendPlatforms = spending
      .map((r) => r.platform)
      .filter((p) => connected.has(p) && (AD_PLATFORMS as readonly string[]).includes(p));
    for (const p of spendPlatforms) byPlatform[p] ??= null;

    return { byPlatform, spendPlatforms, unread, from };
  });
}

/**
 * The least-current of several sources: a total is only as far along as its
 * stalest part, and one that has never been read makes the whole unreadable.
 */
export function stalest(through: SourcesThrough, platforms: readonly string[]): string | null {
  if (platforms.length === 0) return null;
  const days = platforms.map((p) => through.byPlatform[p] ?? null);
  if (days.some((d) => d === null)) return null;
  return [...(days as string[])].sort()[0]!;
}

/**
 * One screen's view of coverage: the range and the comparison period against
 * each source, and the words for each state — so four screens say it the same
 * way.
 */
export function coverageFor(through: SourcesThrough, range: DateRange) {
  const of = (platforms: string | readonly string[], r: DateRange = range): RangeCoverage => {
    const list = typeof platforms === 'string' ? [platforms] : platforms;
    return rangeCoverage(r, stalest(through, list), unreadIn(through, list));
  };
  return {
    of,
    crm: of('salesforce'),
    spend: of(through.spendPlatforms),
    calls: of('call_tracking'),
    spendPlatforms: through.spendPlatforms,
  };
}

/** Every unread day across several sources: a total is missing a day if any part is. */
export function unreadIn(through: SourcesThrough, platforms: readonly string[]): string[] {
  return [...new Set(platforms.flatMap((p) => through.unread?.[p] ?? []))].sort();
}

export const isUnmeasured = (c: RangeCoverage) => c.state === 'none' || c.state === 'never';

const dayLabel = (day: string) => formatRangeLabel({ start: day, end: day });

/** `19–20 Sep, 23 Sep`: unread days as spans. */
export function unreadLabel(days: readonly string[]): string {
  return daySpans(days)
    .map((span) => formatRangeLabel(span))
    .join(', ');
}

/**
 * How a source's cutoff is worded. GA4 and Search Console are bounded by what
 * they have *published*, which trails the sync by days; saying "last synced"
 * for them would name the wrong event.
 */
export type CutoffKind = 'synced' | 'published';

/** Why a figure is not measured, in one line. `source` is a display name. */
export function notMeasuredReason(
  c: RangeCoverage,
  source: string,
  kind: CutoffKind = 'synced',
): string {
  if (c.state === 'never') {
    return kind === 'published' ? `${source} has published nothing yet.` : `${source} has never synced.`;
  }
  if (c.missing.length > 0) return `${source} was not read for ${unreadLabel(c.missing)}.`;
  return kind === 'published'
    ? `${source} has published data through ${dayLabel(c.through!)}; nothing in this range yet.`
    : `${source} last synced ${dayLabel(c.through!)}; nothing in this range has been read.`;
}

/** A suffix for a period label where the range runs past the last read. */
export function throughNote(c: RangeCoverage, source: string, kind: CutoffKind = 'synced'): string {
  if (c.state !== 'partial') return '';
  const parts: string[] = [];
  if (c.missing.length > 0) parts.push(`${source} not read ${unreadLabel(c.missing)}`);
  if (c.through && c.pastThrough) {
    parts.push(`${source} ${kind === 'published' ? 'published' : 'synced'} through ${dayLabel(c.through)}`);
  }
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}


/** The display name for a platform key, or "Paid media" for the spend total. */
export function sourceName(platforms: string | readonly string[]): string {
  if (typeof platforms === 'string') return platformLabel(platforms);
  return platforms.length === 1 ? platformLabel(platforms[0]!) : 'Paid media';
}

/**
 * One point per day for a daily chart, from the rows a source returned.
 *
 * An unread day is `null`, which the chart leaves blank; a day that was read
 * and returned nothing is a measured `0` (Meta with no delivery). The rows
 * alone could not say which is which — a hole and a quiet day both have no
 * row — so the coverage decides. Days past the last read are not drawn.
 */
export function dailyPoints<T extends { date: string }>(
  range: DateRange,
  cover: RangeCoverage,
  rows: readonly T[],
  value: (row: T) => number | null,
): { label: string; value: number | null }[] {
  if (!cover.through || cover.state === 'never') return [];
  const end = range.end < cover.through ? range.end : cover.through;
  if (range.start > end) return [];
  const byDay = new Map(rows.map((r) => [r.date, r]));
  const missing = new Set(cover.missing);
  return eachDay({ start: range.start, end }).map((day) => {
    const row = byDay.get(day);
    return {
      label: day.slice(5),
      value: missing.has(day) ? null : row ? value(row) : 0,
    };
  });
}
