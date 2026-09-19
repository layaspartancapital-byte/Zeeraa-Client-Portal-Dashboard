import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { schema } from '@zeeraa/db';
import { weightedPosition, type DateRange } from '@zeeraa/core';
import { queryTenant, type TenantSession } from '@/lib/tenant';

/**
 * GA4 and Search Console, read back.
 *
 * Two shapes rather than one, because the two sources measure different things:
 * GA4 counts sessions and Search Console counts appearances in a results page.
 * Neither can name a person, so **neither appears anywhere near the attribution
 * join** and no figure here is ever divided into a funded deal.
 *
 * Three rules the queries encode, each of which would be a quiet error if left
 * to a call site:
 *
 *   1. **The day's total comes from the `total` rows**, never from summing the
 *      breakdown. Both APIs cap and withhold: Search Console omits queries
 *      issued by very few people for privacy, and both breakdowns here are the
 *      top N per day. The breakdown is a sample of the total and says so.
 *   2. **Position is impression-weighted.** A plain average of daily positions
 *      weights a day with three impressions like a day with three thousand and
 *      disagrees with the Search Console UI, which is the report a client
 *      checks this against.
 *   3. **CTR is derived, never stored.** A stored ratio is one `sum()` away
 *      from nonsense.
 */

export type OrganicKind = 'ga4' | 'search_console';

export type Ga4Totals = {
  sessions: number;
  engagedSessions: number;
  users: number;
};

export type SearchConsoleTotals = {
  clicks: number;
  impressions: number;
  /** Impression-weighted across the window. Null where nothing was impressed. */
  position: number | null;
};

export type OrganicDay = {
  date: string;
  /** GA4: sessions. Search Console: clicks. */
  primary: number;
  secondary: number;
  tertiary: number;
  position: number | null;
};

export type OrganicBreakdownRow = {
  value: string;
  primary: number;
  secondary: number;
  tertiary: number;
  position: number | null;
};

export type OrganicBreakdown = {
  dimension: string;
  rows: OrganicBreakdownRow[];
  /** Distinct values seen in the window, before the display cap. */
  distinctValues: number;
  /**
   * This breakdown's figure against the authoritative day total.
   *
   * Deliberately *not* called coverage, because it is not bounded by 1. Search
   * Console's grouped and ungrouped totals disagree in both directions:
   * grouping by query omits searches issued by very few people and sums well
   * below the total, while grouping by page can sum slightly above it because a
   * click is attributed per canonical URL. Presenting either as "x% covered"
   * would make the second one read as an error.
   */
  ratioToTotal: number | null;
  /** True where the API's own row ceiling was reached, so the tail is missing. */
  capped: boolean;
};

export type OrganicView = {
  kind: OrganicKind;
  label: string;
  range: DateRange;
  /** The last day the source actually has data for, which is not always `range.end`. */
  lastDayWithData: string | null;
  daysReported: number;
  connection: { status: string; accountIdentifier: string; detail: string | null } | null;
  ga4: Ga4Totals | null;
  searchConsole: SearchConsoleTotals | null;
  daily: OrganicDay[];
  breakdowns: OrganicBreakdown[];
};

const n = (v: unknown): number => Number(v ?? 0);

/**
 * Search Console's own ceiling for one request, and what GA4's limit is set to.
 * Hitting it exactly means the tail was cut rather than exhausted.
 */
const API_ROW_CEILING = 25_000;

export async function organicView(
  session: TenantSession,
  kind: OrganicKind,
  label: string,
  range: DateRange,
  breakdownLimit = 50,
): Promise<OrganicView> {
  return queryTenant(session, async (tx) => {
    const tenantId = session.tenant.id;
    const isGa4 = kind === 'ga4';
    const table = isGa4 ? schema.ga4Metrics : schema.searchConsoleMetrics;

    const where = (dimension?: string) =>
      and(
        eq(table.tenantId, tenantId),
        gte(table.date, range.start),
        lte(table.date, range.end),
        ...(dimension ? [eq(table.dimension, dimension)] : []),
      );

    // Every metric selected for both shapes, so one query serves either source.
    const metrics = isGa4
      ? {
          primary: schema.ga4Metrics.sessions,
          secondary: schema.ga4Metrics.engagedSessions,
          tertiary: schema.ga4Metrics.users,
        }
      : {
          primary: schema.searchConsoleMetrics.clicks,
          secondary: schema.searchConsoleMetrics.impressions,
          tertiary: schema.searchConsoleMetrics.clicks,
        };

    const dayRows = await tx
      .select({
        date: table.date,
        primary: sql<string>`coalesce(sum(${metrics.primary}), 0)`,
        secondary: sql<string>`coalesce(sum(${metrics.secondary}), 0)`,
        tertiary: sql<string>`coalesce(sum(${metrics.tertiary}), 0)`,
        // Carried per day so the window figure can be impression-weighted
        // rather than averaged. Null on GA4, which has no such concept.
        position: isGa4
          ? sql<string | null>`null`
          : sql<string | null>`max(${schema.searchConsoleMetrics.position})`,
        impressions: isGa4
          ? sql<string>`'0'`
          : sql<string>`coalesce(sum(${schema.searchConsoleMetrics.impressions}), 0)`,
      })
      .from(table)
      .where(where('total'))
      .groupBy(table.date)
      .orderBy(asc(table.date));

    const daily: OrganicDay[] = dayRows.map((r) => ({
      date: r.date,
      primary: n(r.primary),
      secondary: n(r.secondary),
      tertiary: n(r.tertiary),
      position: r.position === null ? null : Number(r.position),
    }));

    const dimensions = isGa4 ? ['landing_page', 'source_medium'] : ['query', 'page'];
    const breakdowns: OrganicBreakdown[] = [];
    const totalPrimary = daily.reduce((sum, d) => sum + d.primary, 0);

    for (const dimension of dimensions) {
      const rows = await tx
        .select({
          value: table.dimensionValue,
          primary: sql<string>`coalesce(sum(${metrics.primary}), 0)`,
          secondary: sql<string>`coalesce(sum(${metrics.secondary}), 0)`,
          tertiary: sql<string>`coalesce(sum(${metrics.tertiary}), 0)`,
          position: isGa4
            ? sql<string | null>`null`
            : // Impression-weighted, in SQL, because the rows are aggregated
              // here and a plain avg() would be the exact error this guards.
              sql<string | null>`
                case when sum(${schema.searchConsoleMetrics.impressions}) > 0
                  then sum(${schema.searchConsoleMetrics.position} * ${schema.searchConsoleMetrics.impressions})
                       / sum(${schema.searchConsoleMetrics.impressions})
                  else null end`,
        })
        .from(table)
        .where(where(dimension))
        .groupBy(table.dimensionValue)
        .orderBy(desc(sql`coalesce(sum(${metrics.primary}), 0)`))
        .limit(breakdownLimit);

      const [counted] = await tx
        .select({
          distinct: sql<number>`count(distinct ${table.dimensionValue})::int`,
          total: sql<string>`coalesce(sum(${metrics.primary}), 0)`,
          stored: sql<number>`count(*)::int`,
        })
        .from(table)
        .where(where(dimension));

      breakdowns.push({
        dimension,
        rows: rows.map((r) => ({
          value: r.value,
          primary: n(r.primary),
          secondary: n(r.secondary),
          tertiary: n(r.tertiary),
          position: r.position === null ? null : Number(r.position),
        })),
        distinctValues: Number(counted?.distinct ?? 0),
        // Against the authoritative day totals, not against the breakdown's own
        // sum — which would always be 100% and would say nothing.
        ratioToTotal: totalPrimary > 0 ? n(counted?.total) / totalPrimary : null,
        capped: Number(counted?.stored ?? 0) >= API_ROW_CEILING,
      });
    }

    const [connection] = await tx
      .select({
        status: schema.connections.status,
        accountIdentifier: schema.connections.accountIdentifier,
        lastError: schema.connections.lastError,
        blockedReason: schema.connections.blockedReason,
      })
      .from(schema.connections)
      .where(and(eq(schema.connections.tenantId, tenantId), eq(schema.connections.platform, kind)));

    return {
      kind,
      label,
      range,
      lastDayWithData: daily.at(-1)?.date ?? null,
      daysReported: daily.length,
      connection: connection
        ? {
            status: connection.status,
            accountIdentifier: connection.accountIdentifier,
            detail: connection.blockedReason ?? connection.lastError ?? null,
          }
        : null,
      ga4: isGa4
        ? {
            sessions: daily.reduce((s, d) => s + d.primary, 0),
            engagedSessions: daily.reduce((s, d) => s + d.secondary, 0),
            users: daily.reduce((s, d) => s + d.tertiary, 0),
          }
        : null,
      searchConsole: isGa4
        ? null
        : {
            clicks: daily.reduce((s, d) => s + d.primary, 0),
            impressions: daily.reduce((s, d) => s + d.secondary, 0),
            // The whole reason `position` travels per day: this is weighted,
            // and the plain mean of these numbers would be a different figure.
            position: weightedPosition(
              dayRows.map((r) => ({
                position: r.position === null ? null : Number(r.position),
                impressions: n(r.impressions),
              })),
            ),
          },
      daily,
      breakdowns,
    };
  });
}

/** What each breakdown is called, per source. Never shared between them. */
export const DIMENSION_LABELS: Record<string, string> = {
  landing_page: 'Landing page',
  source_medium: 'Source / medium',
  query: 'Query',
  page: 'Page',
};
