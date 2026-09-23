import 'server-only';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { schema } from '@zeeraa/db';
import {
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
 */
export type SourcesThrough = {
  /** Keyed by platform: `salesforce`, `google_ads`, `ga4`, `call_tracking`, … */
  byPlatform: Record<string, string | null>;
  /** The connected ad platforms that report spend, for the spend total. */
  spendPlatforms: string[];
};

export async function sourcesThrough(session: TenantSession): Promise<SourcesThrough> {
  const tz = session.tenant.timezone;
  return queryTenant(session, async (tx) => {
    const tenantId = session.tenant.id;
    const [connections, runs, [calls], [ga4], [gsc], spending] = await Promise.all([
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

    const connected = new Set(
      connections.filter((c) => c.status !== 'not_configured').map((c) => c.platform),
    );
    const spendPlatforms = spending
      .map((r) => r.platform)
      .filter((p) => connected.has(p) && (AD_PLATFORMS as readonly string[]).includes(p));
    for (const p of spendPlatforms) byPlatform[p] ??= null;

    return { byPlatform, spendPlatforms };
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
  const of = (platforms: string | readonly string[], r: DateRange = range): RangeCoverage =>
    rangeCoverage(r, stalest(through, typeof platforms === 'string' ? [platforms] : platforms));
  return {
    of,
    crm: of('salesforce'),
    spend: of(through.spendPlatforms),
    calls: of('call_tracking'),
    spendPlatforms: through.spendPlatforms,
  };
}

export const isUnmeasured = (c: RangeCoverage) => c.state === 'none' || c.state === 'never';

const dayLabel = (day: string) => formatRangeLabel({ start: day, end: day });

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
  return kind === 'published'
    ? `${source} has published data through ${dayLabel(c.through!)}; nothing in this range yet.`
    : `${source} last synced ${dayLabel(c.through!)}; nothing in this range has been read.`;
}

/** A suffix for a period label where the range runs past the last read. */
export function throughNote(c: RangeCoverage, source: string, kind: CutoffKind = 'synced'): string {
  if (c.state !== 'partial') return '';
  return ` · ${source} ${kind === 'published' ? 'published' : 'synced'} through ${dayLabel(c.through!)}`;
}

/** The display name for a platform key, or "Paid media" for the spend total. */
export function sourceName(platforms: string | readonly string[]): string {
  if (typeof platforms === 'string') return platformLabel(platforms);
  return platforms.length === 1 ? platformLabel(platforms[0]!) : 'Paid media';
}
