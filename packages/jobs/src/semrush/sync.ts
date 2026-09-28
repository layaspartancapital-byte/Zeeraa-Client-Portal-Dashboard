import { and, eq, gte, sql } from 'drizzle-orm';
import {
  holdsAiOverview,
  maxUnitsPerRead,
  monthOf,
  semrushDate,
  semrushReport,
  semrushReportDue,
  SEMRUSH_HISTORY_MONTHS,
  SEMRUSH_ISSUE_TITLES_PRICE,
  SEMRUSH_REPORTS,
  tenantDay,
  addDays,
  type SemrushReport,
  type SemrushReportKey,
} from '@zeeraa/core';
import { SemrushApiError, type SemrushKeywordRow } from '@zeeraa/connectors';
import { schema, withJobTenant, type Database } from '@zeeraa/db';
import { closeSyncRun, openSyncRun, recordSyncedDays, resumeWindow } from '../sync-runs';
import {
  DEFAULT_ANNUAL_UNIT_BUDGET,
  DEFAULT_MAX_UNITS_PER_RUN,
  type SemrushContext,
} from './context';

/**
 * The Semrush sync: every report that is due, and nothing that is not.
 *
 * Runs nightly. Most nights only the two Position Tracking reports are due
 * (200 units); a report's cadence and price are `SEMRUSH_REPORTS` in core, and
 * whether it is due is decided from `seo_report_reads`, which also records
 * what each read cost. That log is the budget: before each call the sync
 * checks the most the call could cost against what is left of this run's cap
 * and of the tenant's trailing-year allowance, and skips — saying so — rather
 * than spend past either.
 *
 * What a read cost is Semrush's own balance before and after it, because the
 * published price is not always the charge (a site audit `history` call cost
 * 500 times its documented price on 28 September 2026). Where the balance does
 * not answer, the documented price is logged instead.
 *
 * Every write is an upsert on the table's natural key. A snapshot re-read in
 * the same month replaces that month; nothing is appended.
 */

export type SemrushReportOutcome = {
  report: SemrushReportKey;
  status: 'read' | 'not_due' | 'skipped' | 'failed';
  rows: number;
  units: number;
  detail: string | null;
};

export type SemrushSyncResult = {
  syncRunId: string;
  status: 'succeeded' | 'partial' | 'failed';
  unitsSpent: number;
  outcomes: SemrushReportOutcome[];
  note: string | null;
};

export type SemrushSyncOptions = {
  trigger?: string;
  now?: Date;
  /** Read these even when not due. Budget checks still apply. */
  force?: SemrushReportKey[];
  /** Read only these. */
  only?: SemrushReportKey[];
};

export async function runSemrushSync(
  context: SemrushContext,
  options: SemrushSyncOptions = {},
): Promise<SemrushSyncResult> {
  const now = options.now ?? new Date();
  const today = tenantDay(now, context.tenantTimezone);
  const { tenantId, client, config } = context;
  const runInTenant = <T>(fn: (tx: Database) => Promise<T>) => withJobTenant(tenantId, fn);

  const syncRunId = await runInTenant((tx) =>
    openSyncRun(tx, tenantId, options.trigger ?? 'nightly', now, 'semrush'),
  );
  const result: SemrushSyncResult = { syncRunId, status: 'succeeded', unitsSpent: 0, outcomes: [], note: null };

  const runCap = config.maxUnitsPerRun ?? DEFAULT_MAX_UNITS_PER_RUN;
  const annualCap = config.annualUnitBudget ?? DEFAULT_ANNUAL_UNIT_BUDGET;
  const { lastRead, spentThisYear } = await runInTenant((tx) => readLog(tx, tenantId, today));

  const tracking = Boolean(config.trackingCampaignId && config.trackingUrl);
  const month = monthOf(today);
  const toDay = (epochSeconds: number) => tenantDay(new Date(epochSeconds * 1000), context.tenantTimezone);

  /** Whether a read that could cost `max` fits both caps. */
  const affordable = (max: number) => {
    if (result.unitsSpent + max > runCap) return `this run's cap of ${runCap.toLocaleString('en-US')} units`;
    if (spentThisYear + result.unitsSpent + max > annualCap) {
      return `the ${annualCap.toLocaleString('en-US')}-unit allowance for the trailing year`;
    }
    return null;
  };

  /** One call, measured. Returns the units it cost. */
  const measured = async <T>(call: () => Promise<T>, fallback: (value: T) => number) => {
    const before = await client.balance().catch(() => null);
    const value = await call();
    const after = await client.balance().catch(() => null);
    const units = before !== null && after !== null && after <= before ? before - after : fallback(value);
    result.unitsSpent += units;
    return { value, units };
  };

  const perLine = (report: SemrushReport) => (rows: unknown[]) =>
    report.perLine ? report.price * rows.length : report.price;

  for (const report of SEMRUSH_REPORTS) {
    if (options.only && !options.only.includes(report.key)) continue;
    const outcome: SemrushReportOutcome = { report: report.key, status: 'not_due', rows: 0, units: 0, detail: null };
    result.outcomes.push(outcome);

    const due = options.force?.includes(report.key) || semrushReportDue(report.cadence, lastRead.get(report.key) ?? null, today);
    if (!due) continue;
    if (report.tracking && !tracking) {
      outcome.status = 'skipped';
      outcome.detail = 'No Position Tracking campaign is recorded on the connection.';
      continue;
    }

    // A history report's first read asks for two years; after that, the
    // latest two months.
    const firstRead = !lastRead.has(report.key);
    const lines =
      (report.key === 'domain_history' || report.key === 'backlinks_history') && firstRead
        ? SEMRUSH_HISTORY_MONTHS
        : report.key === 'tracking_positions'
          ? (config.trackedKeywords ?? report.lines)
          : report.lines;
    const max = maxUnitsPerRead(report, lines) + (report.key === 'site_audit' ? SEMRUSH_ISSUE_TITLES_PRICE : 0);
    const over = affordable(max);
    if (over) {
      outcome.status = 'skipped';
      outcome.detail = `Up to ${max.toLocaleString('en-US')} units would pass ${over}.`;
      continue;
    }

    try {
      const { rows, units } = await readReport(report, lines);
      outcome.status = 'read';
      outcome.rows = rows;
      outcome.units = units;
      await runInTenant((tx) =>
        tx.insert(schema.seoReportReads).values({
          tenantId,
          report: report.key,
          readAt: new Date(),
          readOn: today,
          units,
          rows,
          syncRunId,
        }),
      );
    } catch (error) {
      outcome.status = 'failed';
      outcome.detail = error instanceof Error ? error.message : String(error);
      // An empty balance or a refused key fails every report after it too.
      if (error instanceof SemrushApiError && error.fatal) break;
    }
  }

  async function readReport(report: SemrushReport, lines: number): Promise<{ rows: number; units: number }> {
    switch (report.key) {
      case 'domain_overview': {
        const { value, units } = await measured(() => client.domainRank(config.domain, config.database), () => report.price);
        if (!value) return { rows: 0, units };
        await runInTenant((tx) =>
          upsertDomainMonth(tx, { tenantId, database: config.database, month, readOn: today, syncRunId, ...value }),
        );
        return { rows: 1, units };
      }
      case 'domain_history': {
        const { value, units } = await measured(
          () => client.domainRankHistory(config.domain, config.database, lines),
          (rows) => report.price * rows.length,
        );
        let written = 0;
        await runInTenant(async (tx) => {
          for (const row of value) {
            const day = semrushDate(row.date);
            // The month in progress is the live read's, never history's.
            if (!day || monthOf(day) >= month) continue;
            await upsertDomainMonth(tx, {
              tenantId, database: config.database, month: monthOf(day), readOn: today, syncRunId, ...row,
            });
            written += 1;
          }
        });
        return { rows: written, units };
      }
      case 'top_keywords':
      case 'ai_overview_keywords': {
        const list = report.key === 'top_keywords' ? 'top_organic' : 'ai_overview';
        const { value, units } = await measured(
          () =>
            list === 'top_organic'
              ? client.topKeywords(config.domain, config.database, lines)
              : client.serpFeatureKeywords(config.domain, config.database, lines),
          perLine(report),
        );
        // A SERP-feature position can be a featured snippet or an image pack;
        // only the AI Overview citations are this list.
        const rows = list === 'ai_overview' ? value.filter((r) => holdsAiOverview(r.serpFeaturesHeld)) : value;
        await runInTenant((tx) => upsertKeywords(tx, tenantId, config.database, month, list, rows, today, syncRunId));
        return { rows: rows.length, units };
      }
      case 'competitors': {
        const { value, units } = await measured(
          () => client.organicCompetitors(config.domain, config.database, lines),
          perLine(report),
        );
        await runInTenant(async (tx) => {
          for (const c of value) {
            const row = {
              tenantId, database: config.database, month, domain: c.domain,
              relevance: String(c.relevance), commonKeywords: c.commonKeywords,
              organicKeywords: c.organicKeywords, organicTraffic: c.organicTraffic,
              organicTrafficCost: c.organicTrafficCost.toFixed(2), readOn: today, syncRunId,
            };
            await tx.insert(schema.seoCompetitors).values(row).onConflictDoUpdate({
              target: [schema.seoCompetitors.tenantId, schema.seoCompetitors.database, schema.seoCompetitors.month, schema.seoCompetitors.domain],
              set: row,
            });
          }
        });
        return { rows: value.length, units };
      }
      case 'backlinks_overview': {
        const { value, units } = await measured(() => client.backlinksOverview(config.domain), () => report.price);
        if (!value) return { rows: 0, units };
        await runInTenant((tx) => upsertBacklinkMonth(tx, { tenantId, month, readOn: today, syncRunId, ...value }));
        return { rows: 1, units };
      }
      case 'backlinks_history': {
        const { value, units } = await measured(() => client.backlinksHistory(config.domain, lines), perLine(report));
        let written = 0;
        await runInTenant(async (tx) => {
          for (const row of value) {
            const m = monthOf(toDay(row.at));
            if (m >= month) continue;
            await upsertBacklinkMonth(tx, {
              tenantId, month: m, readOn: today, syncRunId,
              authorityScore: row.authorityScore, backlinks: row.backlinks,
              referringDomains: row.referringDomains, followBacklinks: null, nofollowBacklinks: null,
            });
            written += 1;
          }
        });
        return { rows: written, units };
      }
      case 'referring_domains_new':
      case 'referring_domains_lost': {
        const change = report.key === 'referring_domains_new' ? 'new' : 'lost';
        const { value, units } = await measured(
          () => client.referringDomains(config.domain, change, lines),
          perLine(report),
        );
        await runInTenant(async (tx) => {
          for (const d of value) {
            const row = {
              tenantId, change, domain: d.domain, authorityScore: d.authorityScore, backlinks: d.backlinks,
              firstSeen: toDay(d.firstSeen), lastSeen: toDay(d.lastSeen), readOn: today, syncRunId,
            };
            await tx.insert(schema.seoReferringDomainChanges).values(row).onConflictDoUpdate({
              target: [schema.seoReferringDomainChanges.tenantId, schema.seoReferringDomainChanges.change, schema.seoReferringDomainChanges.domain],
              set: row,
            });
          }
        });
        return { rows: value.length, units };
      }
      case 'site_audit': {
        const { value: audit, units } = await measured(() => client.siteAudit(config.projectId), () => report.price);
        if (!audit) return { rows: 0, units };
        const known = await runInTenant(async (tx) => {
          const [row] = await tx
            .select({ id: schema.seoSiteAudits.snapshotId })
            .from(schema.seoSiteAudits)
            .where(and(eq(schema.seoSiteAudits.tenantId, tenantId), eq(schema.seoSiteAudits.snapshotId, audit.snapshotId)));
          return Boolean(row);
        });
        // The same crawl read again: nothing to write, and no reason to pay
        // for the issue names a second time.
        if (known) return { rows: 0, units };
        const titles = await measured(() => client.siteAuditIssueTitles(config.projectId), () => SEMRUSH_ISSUE_TITLES_PRICE);
        await runInTenant(async (tx) => {
          const finishedAt = new Date(audit.finishedAt);
          await tx.insert(schema.seoSiteAudits).values({
            tenantId, projectId: config.projectId, snapshotId: audit.snapshotId, finishedAt,
            finishedOn: tenantDay(finishedAt, context.tenantTimezone), healthScore: audit.healthScore,
            aiSearchScore: audit.aiSearchScore, thematicScores: audit.thematicScores,
            pagesCrawled: audit.pagesCrawled, pagesLimit: audit.pagesLimit, errors: audit.errors,
            warnings: audit.warnings, notices: audit.notices, readOn: today, syncRunId,
          });
          if (audit.issues.length > 0) {
            await tx.insert(schema.seoSiteAuditIssues).values(
              audit.issues.map((i) => ({
                tenantId, snapshotId: audit.snapshotId, issueId: i.id, severity: i.severity,
                title: titles.value.get(i.id) ?? `Issue ${i.id}`, count: i.count, delta: i.delta,
              })),
            );
          }
        });
        return { rows: 1 + audit.issues.length, units: units + titles.units };
      }
      case 'tracking_positions': {
        const campaign = config.trackingCampaignId!;
        const url = config.trackingUrl!;
        // A read costs the same for one day or ninety, so it reaches back to
        // the oldest day not yet read final, up to ninety.
        const range = await runInTenant((tx) =>
          resumeWindow(tx, tenantId, 'semrush', { today, floorDays: 8, maxDays: 90 }),
        );
        const pageSize = 500;
        let offset = 0;
        let written = 0;
        let spent = 0;
        const days = new Set<string>();
        for (;;) {
          const { value, units } = await measured(
            () => client.trackedPositions(campaign, url, range, { limit: pageSize, offset }),
            (v) => report.price * new Set(v.rows.map((r) => r.keyword)).size,
          );
          spent += units;
          // Batched: ninety days of eighty keywords is 7,200 rows, and one
          // statement each would not fit the nightly's budget on Neon.
          await runInTenant(async (tx) => {
            const rows = value.rows.map((p) => ({
              tenantId, campaignId: campaign, day: p.day, keyword: p.keyword, position: p.position,
              url: p.url, searchVolume: p.searchVolume, syncRunId,
            }));
            for (let i = 0; i < rows.length; i += 1000) {
              await tx
                .insert(schema.seoTrackedPositions)
                .values(rows.slice(i, i + 1000))
                .onConflictDoUpdate({
                  target: [schema.seoTrackedPositions.tenantId, schema.seoTrackedPositions.campaignId, schema.seoTrackedPositions.day, schema.seoTrackedPositions.keyword],
                  set: {
                    position: sql`excluded.position`,
                    url: sql`excluded.url`,
                    searchVolume: sql`excluded.search_volume`,
                    syncRunId: sql`excluded.sync_run_id`,
                  },
                });
            }
            for (const p of value.rows) days.add(p.day);
          });
          written += value.rows.length;
          const keywords = new Set(value.rows.map((r) => r.keyword)).size;
          offset += pageSize;
          const more = value.total !== null ? offset < value.total : keywords === pageSize;
          if (!more || affordable(report.price * pageSize)) break;
        }
        // Only the days Semrush answered for. A day it has not harvested yet
        // stays unread rather than reading as a day with no rankings.
        await runInTenant(async (tx) => {
          for (const day of [...days].sort()) {
            if (day < range.start || day > today) continue;
            await recordSyncedDays(tx, tenantId, 'semrush', { start: day, end: day }, { today, syncRunId });
          }
        });
        return { rows: written, units: spent };
      }
      case 'tracking_visibility': {
        const campaign = config.trackingCampaignId!;
        const range = { start: addDays(today, -89), end: today };
        const { value, units } = await measured(
          () => client.trackedVisibility(campaign, config.trackingUrl!, range),
          () => report.price,
        );
        await runInTenant(async (tx) => {
          for (const v of value) {
            const row = { tenantId, campaignId: campaign, day: v.day, visibility: v.visibility.toFixed(3), syncRunId };
            await tx.insert(schema.seoTrackingVisibility).values(row).onConflictDoUpdate({
              target: [schema.seoTrackingVisibility.tenantId, schema.seoTrackingVisibility.campaignId, schema.seoTrackingVisibility.day],
              set: row,
            });
          }
        });
        return { rows: value.length, units };
      }
    }
  }

  const failed = result.outcomes.filter((o) => o.status === 'failed');
  const skipped = result.outcomes.filter((o) => o.status === 'skipped');
  const read = result.outcomes.filter((o) => o.status === 'read');
  result.status = failed.length > 0 && read.length === 0 ? 'failed' : failed.length + skipped.length > 0 ? 'partial' : 'succeeded';
  result.note =
    [
      `${result.unitsSpent.toLocaleString('en-US')} units`,
      ...failed.map((o) => `${semrushReport(o.report).label} failed: ${o.detail}`),
      ...skipped.map((o) => `${semrushReport(o.report).label} skipped: ${o.detail}`),
    ].join('; ') || null;
  await runInTenant((tx) =>
    closeSyncRun(
      tx,
      syncRunId,
      result.status,
      read.reduce((n, o) => n + o.rows, 0),
      result.status === 'succeeded' ? null : result.note,
    ),
  );
  return result;
}

/** The newest read of each report, and what the trailing year has cost. */
async function readLog(tx: Database, tenantId: string, today: string) {
  const rows = await tx
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
  return {
    lastRead: new Map(rows.map((r) => [r.report, r.last])),
    spentThisYear: Number(spent?.units ?? 0),
  };
}

async function upsertDomainMonth(
  tx: Database,
  r: {
    tenantId: string; database: string; month: string; readOn: string; syncRunId: string;
    rank: number | null; organicKeywords: number; positions1to3: number; positions4to10: number;
    positions11to20: number; organicTraffic: number; organicTrafficCost: number;
    aiOverviewKeywords: number; aiOverviewCited: number;
  },
) {
  const row = {
    tenantId: r.tenantId, database: r.database, month: r.month, readOn: r.readOn,
    semrushRank: r.rank, organicKeywords: r.organicKeywords, positions1to3: r.positions1to3,
    positions4to10: r.positions4to10, positions11to20: r.positions11to20,
    organicTraffic: r.organicTraffic, organicTrafficCost: r.organicTrafficCost.toFixed(2),
    aiOverviewKeywords: r.aiOverviewKeywords, aiOverviewCited: r.aiOverviewCited,
    syncRunId: r.syncRunId, updatedAt: new Date(),
  };
  await tx.insert(schema.seoDomainMonths).values(row).onConflictDoUpdate({
    target: [schema.seoDomainMonths.tenantId, schema.seoDomainMonths.database, schema.seoDomainMonths.month],
    set: row,
  });
}

async function upsertBacklinkMonth(
  tx: Database,
  r: {
    tenantId: string; month: string; readOn: string; syncRunId: string; authorityScore: number;
    backlinks: number; referringDomains: number; followBacklinks: number | null; nofollowBacklinks: number | null;
  },
) {
  const row = { ...r, updatedAt: new Date() };
  await tx.insert(schema.seoBacklinkMonths).values(row).onConflictDoUpdate({
    target: [schema.seoBacklinkMonths.tenantId, schema.seoBacklinkMonths.month],
    set: row,
  });
}

/**
 * A month's list, as of today's read. A keyword that fell out of the list
 * keeps its row from the earlier read with its older `read_on`; the screen
 * reads the newest read of each month and list, so it is not shown.
 */
async function upsertKeywords(
  tx: Database,
  tenantId: string,
  database: string,
  month: string,
  list: 'top_organic' | 'ai_overview',
  rows: readonly SemrushKeywordRow[],
  readOn: string,
  syncRunId: string,
) {
  const seen = new Set<string>();
  for (const k of rows) {
    if (!k.keyword || seen.has(k.keyword)) continue;
    seen.add(k.keyword);
    const row = {
      tenantId, database, month, list, keyword: k.keyword, position: k.position,
      previousPosition: k.previousPosition, searchVolume: k.searchVolume,
      cpc: k.cpc === null ? null : k.cpc.toFixed(2), url: k.url,
      trafficShare: k.trafficShare === null ? null : k.trafficShare.toFixed(2),
      keywordDifficulty: k.keywordDifficulty === null ? null : k.keywordDifficulty.toFixed(2),
      intents: k.intents, serpFeatures: k.serpFeatures, serpFeaturesHeld: k.serpFeaturesHeld,
      readOn, syncRunId,
    };
    await tx.insert(schema.seoKeywords).values(row).onConflictDoUpdate({
      target: [schema.seoKeywords.tenantId, schema.seoKeywords.database, schema.seoKeywords.month, schema.seoKeywords.list, schema.seoKeywords.keyword],
      set: row,
    });
  }
}
