import 'server-only';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import {
  addDays,
  improvementDirectionFor,
  positionBands,
  positionMove,
  SEMRUSH_REPORTS,
  type DateRange,
  type ImprovementDirection,
  type PositionBands,
  type PositionMove,
} from '@zeeraa/core';
import { schema } from '@zeeraa/db';
import { queryTenant, type TenantSession } from '@/lib/tenant';

/**
 * The SEO page, from Semrush.
 *
 * Two kinds of figure, and the page never mixes them:
 *
 *   * **Snapshots** — keywords, estimated traffic, AI Overview presence,
 *     backlinks, the site audit. Each is "as of" the day it was read, and is
 *     compared with the month before (or the crawl before), because a stock
 *     is compared with its earlier level, not summed over a range.
 *   * **Position Tracking**, which is by day and follows the page's range.
 *
 * Every figure here is Semrush's. Estimated traffic is Semrush's model of the
 * domain's visits, not a measurement — Search Console and GA4 have the
 * measured figures — and the page says so beside it.
 */

export type SeoMonth = {
  month: string;
  readOn: string;
  organicKeywords: number;
  positions1to3: number;
  positions4to10: number;
  positions11to20: number;
  organicTraffic: number;
  aiOverviewKeywords: number;
  aiOverviewCited: number;
};

export type SeoBacklinkMonth = {
  month: string;
  readOn: string;
  authorityScore: number;
  backlinks: number;
  referringDomains: number;
  followBacklinks: number | null;
  nofollowBacklinks: number | null;
};

export type SeoKeyword = {
  keyword: string;
  position: number;
  previousPosition: number | null;
  searchVolume: number;
  url: string;
  trafficShare: number | null;
  keywordDifficulty: number | null;
  intents: string | null;
  aiOverview: boolean;
};

export type SeoCompetitor = {
  domain: string;
  relevance: number;
  commonKeywords: number;
  organicKeywords: number;
  organicTraffic: number;
};

export type SeoDomainChange = {
  domain: string;
  authorityScore: number;
  backlinks: number;
  /** First seen for a new domain, last seen for a lost one. */
  on: string;
};

export type SeoDomainChanges = {
  rows: SeoDomainChange[];
  /** How many fell in the range. */
  inRange: number;
  /**
   * Where the stored list stops being complete: the read is capped, so when
   * it came back full its oldest entry is as far back as it can speak for.
   * Null when the read was not full, so the list is complete.
   */
  completeFrom: string | null;
  readOn: string | null;
};

export type SeoAudit = {
  snapshotId: string;
  finishedOn: string;
  healthScore: number;
  aiSearchScore: number | null;
  thematicScores: Record<string, number>;
  pagesCrawled: number;
  errors: number;
  warnings: number;
  notices: number;
  issues: { id: number; severity: 'error' | 'warning' | 'notice'; title: string; count: number; delta: number }[];
};

export type SeoTrackedKeyword = {
  keyword: string;
  searchVolume: number | null;
  start: number | null;
  end: number | null;
  move: PositionMove;
  url: string | null;
};

export type SeoTracking = {
  campaignId: string;
  /** The first and last days in the range Semrush harvested. */
  firstDay: string | null;
  lastDay: string | null;
  bandsStart: PositionBands | null;
  bandsEnd: PositionBands | null;
  visibility: { day: string; value: number }[];
  keywords: SeoTrackedKeyword[];
};

export type SeoView = {
  connection: { status: string; projectId: number | null; domain: string | null; database: string } | null;
  months: SeoMonth[];
  current: SeoMonth | null;
  previous: SeoMonth | null;
  backlinkMonths: SeoBacklinkMonth[];
  backlinks: SeoBacklinkMonth | null;
  backlinksPrevious: SeoBacklinkMonth | null;
  topKeywords: { rows: SeoKeyword[]; month: string | null; readOn: string | null; read: number };
  aiOverview: { rows: SeoKeyword[]; readOn: string | null };
  competitors: { rows: SeoCompetitor[]; readOn: string | null };
  newDomains: SeoDomainChanges;
  lostDomains: SeoDomainChanges;
  audit: SeoAudit | null;
  auditPrevious: { finishedOn: string; healthScore: number } | null;
  /** Null when no campaign is recorded or it has reported nothing. */
  tracking: SeoTracking | null;
  trackingConfigured: boolean;
  /** For Zeeraa staff: what the last year of reads cost. */
  units: { trailingYear: number; budget: number; lastRead: Record<string, string> };
  directions: Record<
    | 'organic_keywords'
    | 'estimated_organic_traffic'
    | 'ai_overview_citations'
    | 'referring_domains'
    | 'authority_score'
    | 'site_health'
    | 'tracked_visibility'
    | 'tracked_top_10',
    ImprovementDirection | null
  >;
};

/** The row cap each change list is read with; see `SEMRUSH_REPORTS`. */
const CHANGE_CAP = SEMRUSH_REPORTS.find((r) => r.key === 'referring_domains_new')!.lines;

export async function seoView(session: TenantSession, range: DateRange): Promise<SeoView> {
  return queryTenant(session, async (tx) => {
    const tenantId = session.tenant.id;

    const [connection] = await tx
      .select({ status: schema.connections.status, config: schema.connections.config })
      .from(schema.connections)
      .where(and(eq(schema.connections.tenantId, tenantId), eq(schema.connections.platform, 'semrush')))
      .limit(1);
    const config = (connection?.config ?? {}) as {
      projectId?: number;
      domain?: string;
      database?: string;
      trackingCampaignId?: string | null;
      annualUnitBudget?: number;
    };
    const database = config.database ?? 'us';

    const monthRows = await tx
      .select()
      .from(schema.seoDomainMonths)
      .where(and(eq(schema.seoDomainMonths.tenantId, tenantId), eq(schema.seoDomainMonths.database, database)))
      .orderBy(desc(schema.seoDomainMonths.month))
      .limit(13);
    const months: SeoMonth[] = monthRows
      .map((m) => ({
        month: m.month,
        readOn: m.readOn,
        organicKeywords: m.organicKeywords,
        positions1to3: m.positions1to3,
        positions4to10: m.positions4to10,
        positions11to20: m.positions11to20,
        organicTraffic: m.organicTraffic,
        aiOverviewKeywords: m.aiOverviewKeywords,
        aiOverviewCited: m.aiOverviewCited,
      }))
      .reverse();

    const backlinkRows = await tx
      .select()
      .from(schema.seoBacklinkMonths)
      .where(eq(schema.seoBacklinkMonths.tenantId, tenantId))
      .orderBy(desc(schema.seoBacklinkMonths.month))
      .limit(13);
    const backlinkMonths: SeoBacklinkMonth[] = backlinkRows
      .map((b) => ({
        month: b.month,
        readOn: b.readOn,
        authorityScore: b.authorityScore,
        backlinks: Number(b.backlinks),
        referringDomains: b.referringDomains,
        followBacklinks: b.followBacklinks === null ? null : Number(b.followBacklinks),
        nofollowBacklinks: b.nofollowBacklinks === null ? null : Number(b.nofollowBacklinks),
      }))
      .reverse();

    // The newest read of the newest month, per list. A keyword a later read
    // dropped keeps its older row and is not shown.
    const latestList = async (list: 'top_organic' | 'ai_overview') => {
      const [latest] = await tx
        .select({ month: schema.seoKeywords.month, readOn: schema.seoKeywords.readOn })
        .from(schema.seoKeywords)
        .where(and(eq(schema.seoKeywords.tenantId, tenantId), eq(schema.seoKeywords.database, database), eq(schema.seoKeywords.list, list)))
        .orderBy(desc(schema.seoKeywords.month), desc(schema.seoKeywords.readOn))
        .limit(1);
      if (!latest) return { rows: [] as SeoKeyword[], month: null, readOn: null };
      const rows = await tx
        .select()
        .from(schema.seoKeywords)
        .where(
          and(
            eq(schema.seoKeywords.tenantId, tenantId),
            eq(schema.seoKeywords.database, database),
            eq(schema.seoKeywords.list, list),
            eq(schema.seoKeywords.month, latest.month),
            eq(schema.seoKeywords.readOn, latest.readOn),
          ),
        )
        .orderBy(
          list === 'top_organic'
            ? sql`${schema.seoKeywords.trafficShare} desc nulls last`
            : desc(schema.seoKeywords.searchVolume),
          asc(schema.seoKeywords.position),
        );
      return {
        month: latest.month,
        readOn: latest.readOn,
        rows: rows.map((k) => ({
          keyword: k.keyword,
          position: k.position,
          previousPosition: k.previousPosition,
          searchVolume: k.searchVolume,
          url: k.url,
          trafficShare: k.trafficShare === null ? null : Number(k.trafficShare),
          keywordDifficulty: k.keywordDifficulty === null ? null : Number(k.keywordDifficulty),
          intents: k.intents,
          aiOverview: list === 'ai_overview',
        })),
      };
    };
    const top = await latestList('top_organic');
    const aio = await latestList('ai_overview');
    const cited = new Set(aio.rows.map((r) => r.keyword));
    for (const row of top.rows) row.aiOverview = cited.has(row.keyword);

    const [latestCompetitors] = await tx
      .select({ month: schema.seoCompetitors.month, readOn: schema.seoCompetitors.readOn })
      .from(schema.seoCompetitors)
      .where(and(eq(schema.seoCompetitors.tenantId, tenantId), eq(schema.seoCompetitors.database, database)))
      .orderBy(desc(schema.seoCompetitors.month), desc(schema.seoCompetitors.readOn))
      .limit(1);
    const competitorRows = latestCompetitors
      ? await tx
          .select()
          .from(schema.seoCompetitors)
          .where(
            and(
              eq(schema.seoCompetitors.tenantId, tenantId),
              eq(schema.seoCompetitors.database, database),
              eq(schema.seoCompetitors.month, latestCompetitors.month),
              eq(schema.seoCompetitors.readOn, latestCompetitors.readOn),
            ),
          )
          .orderBy(desc(schema.seoCompetitors.relevance))
      : [];

    const changes = async (change: 'new' | 'lost'): Promise<SeoDomainChanges> => {
      const on = change === 'new' ? schema.seoReferringDomainChanges.firstSeen : schema.seoReferringDomainChanges.lastSeen;
      const [latest] = await tx
        .select({ readOn: schema.seoReferringDomainChanges.readOn })
        .from(schema.seoReferringDomainChanges)
        .where(and(eq(schema.seoReferringDomainChanges.tenantId, tenantId), eq(schema.seoReferringDomainChanges.change, change)))
        .orderBy(desc(schema.seoReferringDomainChanges.readOn))
        .limit(1);
      if (!latest) return { rows: [], inRange: 0, completeFrom: null, readOn: null };
      const lastRead = await tx
        .select({ on })
        .from(schema.seoReferringDomainChanges)
        .where(
          and(
            eq(schema.seoReferringDomainChanges.tenantId, tenantId),
            eq(schema.seoReferringDomainChanges.change, change),
            eq(schema.seoReferringDomainChanges.readOn, latest.readOn),
          ),
        );
      const completeFrom =
        lastRead.length >= CHANGE_CAP ? lastRead.map((r) => r.on).sort()[0] ?? null : null;
      const rows = await tx
        .select()
        .from(schema.seoReferringDomainChanges)
        .where(
          and(
            eq(schema.seoReferringDomainChanges.tenantId, tenantId),
            eq(schema.seoReferringDomainChanges.change, change),
            gte(on, range.start),
            lte(on, range.end),
          ),
        )
        .orderBy(desc(on), desc(schema.seoReferringDomainChanges.authorityScore));
      return {
        readOn: latest.readOn,
        completeFrom,
        inRange: rows.length,
        rows: rows.map((r) => ({
          domain: r.domain,
          authorityScore: r.authorityScore,
          backlinks: r.backlinks,
          on: change === 'new' ? r.firstSeen : r.lastSeen,
        })),
      };
    };

    const audits = await tx
      .select()
      .from(schema.seoSiteAudits)
      .where(eq(schema.seoSiteAudits.tenantId, tenantId))
      .orderBy(desc(schema.seoSiteAudits.finishedAt))
      .limit(2);
    const [latestAudit, priorAudit] = audits;
    const issues = latestAudit
      ? await tx
          .select()
          .from(schema.seoSiteAuditIssues)
          .where(and(eq(schema.seoSiteAuditIssues.tenantId, tenantId), eq(schema.seoSiteAuditIssues.snapshotId, latestAudit.snapshotId)))
      : [];
    const severityRank = { error: 0, warning: 1, notice: 2 } as const;

    let tracking: SeoTracking | null = null;
    const campaignId = config.trackingCampaignId ?? null;
    if (campaignId) {
      const positions = await tx
        .select()
        .from(schema.seoTrackedPositions)
        .where(
          and(
            eq(schema.seoTrackedPositions.tenantId, tenantId),
            eq(schema.seoTrackedPositions.campaignId, campaignId),
            gte(schema.seoTrackedPositions.day, range.start),
            lte(schema.seoTrackedPositions.day, range.end),
          ),
        );
      const visibility = await tx
        .select({ day: schema.seoTrackingVisibility.day, value: schema.seoTrackingVisibility.visibility })
        .from(schema.seoTrackingVisibility)
        .where(
          and(
            eq(schema.seoTrackingVisibility.tenantId, tenantId),
            eq(schema.seoTrackingVisibility.campaignId, campaignId),
            gte(schema.seoTrackingVisibility.day, range.start),
            lte(schema.seoTrackingVisibility.day, range.end),
          ),
        )
        .orderBy(asc(schema.seoTrackingVisibility.day));
      if (positions.length > 0 || visibility.length > 0) {
        const days = [...new Set(positions.map((p) => p.day))].sort();
        const firstDay = days[0] ?? null;
        const lastDay = days.at(-1) ?? null;
        const on = (day: string | null) => positions.filter((p) => p.day === day);
        const startRows = on(firstDay);
        const endRows = on(lastDay);
        const startBy = new Map(startRows.map((p) => [p.keyword, p]));
        const keywords = [...new Set(positions.map((p) => p.keyword))].map((keyword) => {
          const end = endRows.find((p) => p.keyword === keyword) ?? null;
          const start = startBy.get(keyword) ?? null;
          return {
            keyword,
            searchVolume: end?.searchVolume ?? start?.searchVolume ?? null,
            start: start?.position ?? null,
            end: end?.position ?? null,
            move: positionMove(start?.position ?? null, end?.position ?? null),
            url: end?.url ?? start?.url ?? null,
          };
        });
        keywords.sort((a, b) => (a.end ?? 999) - (b.end ?? 999) || (b.searchVolume ?? 0) - (a.searchVolume ?? 0));
        tracking = {
          campaignId,
          firstDay,
          lastDay,
          bandsStart: startRows.length ? positionBands(startRows.map((p) => p.position)) : null,
          bandsEnd: endRows.length ? positionBands(endRows.map((p) => p.position)) : null,
          visibility: visibility.map((v) => ({ day: v.day, value: Number(v.value) })),
          keywords,
        };
      }
    }

    const today = range.end;
    const reads = await tx
      .select({
        report: schema.seoReportReads.report,
        last: sql<string>`to_char(max(${schema.seoReportReads.readOn}), 'YYYY-MM-DD')`,
      })
      .from(schema.seoReportReads)
      .where(eq(schema.seoReportReads.tenantId, tenantId))
      .groupBy(schema.seoReportReads.report);
    const [spent] = await tx
      .select({ units: sql<string>`coalesce(sum(${schema.seoReportReads.units}), 0)` })
      .from(schema.seoReportReads)
      .where(and(eq(schema.seoReportReads.tenantId, tenantId), gte(schema.seoReportReads.readOn, addDays(today, -364))));

    const current = months.at(-1) ?? null;
    const previous = months.length > 1 ? months.at(-2)! : null;
    const backlinks = backlinkMonths.at(-1) ?? null;

    return {
      connection: connection
        ? { status: connection.status, projectId: config.projectId ?? null, domain: config.domain ?? null, database }
        : null,
      months,
      current,
      previous,
      backlinkMonths,
      backlinks,
      backlinksPrevious: backlinkMonths.length > 1 ? backlinkMonths.at(-2)! : null,
      topKeywords: { rows: top.rows, month: top.month, readOn: top.readOn, read: top.rows.length },
      aiOverview: { rows: aio.rows, readOn: aio.readOn },
      competitors: {
        readOn: latestCompetitors?.readOn ?? null,
        rows: competitorRows.map((c) => ({
          domain: c.domain,
          relevance: Number(c.relevance),
          commonKeywords: c.commonKeywords,
          organicKeywords: c.organicKeywords,
          organicTraffic: c.organicTraffic,
        })),
      },
      newDomains: await changes('new'),
      lostDomains: await changes('lost'),
      audit: latestAudit
        ? {
            snapshotId: latestAudit.snapshotId,
            finishedOn: latestAudit.finishedOn,
            healthScore: latestAudit.healthScore,
            aiSearchScore: latestAudit.aiSearchScore,
            thematicScores: latestAudit.thematicScores,
            pagesCrawled: latestAudit.pagesCrawled,
            errors: latestAudit.errors,
            warnings: latestAudit.warnings,
            notices: latestAudit.notices,
            issues: issues
              .map((i) => ({
                id: i.issueId,
                severity: i.severity as 'error' | 'warning' | 'notice',
                title: i.title,
                count: i.count,
                delta: i.delta,
              }))
              .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.count - a.count),
          }
        : null,
      auditPrevious: priorAudit ? { finishedOn: priorAudit.finishedOn, healthScore: priorAudit.healthScore } : null,
      tracking,
      trackingConfigured: Boolean(campaignId),
      units: {
        trailingYear: Number(spent?.units ?? 0),
        budget: config.annualUnitBudget ?? 400_000,
        lastRead: Object.fromEntries(reads.map((r) => [r.report, r.last])),
      },
      directions: {
        organic_keywords: improvementDirectionFor('organic_keywords'),
        estimated_organic_traffic: improvementDirectionFor('estimated_organic_traffic'),
        ai_overview_citations: improvementDirectionFor('ai_overview_citations'),
        referring_domains: improvementDirectionFor('referring_domains'),
        authority_score: improvementDirectionFor('authority_score'),
        site_health: improvementDirectionFor('site_health'),
        tracked_visibility: improvementDirectionFor('tracked_visibility'),
        tracked_top_10: improvementDirectionFor('tracked_top_10'),
      },
    };
  });
}
