import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance, type Database } from '@zeeraa/db';
import {
  addDays,
  daySpans,
  eachDay,
  formatRangeLabel,
  monthRange,
  parseWallClock,
  previousMonth,
  tenantDay,
  type DateRange,
} from '@zeeraa/core';
import {
  NO_LEAD_EXCLUSION,
  STAGE_NAME_ALIASES,
  ga4Client,
  inboundClause,
  searchConsoleClient,
} from '@zeeraa/connectors';
import { resolveGoogleAdsContext } from './google-ads/context';
import { resolveMetaContext } from './meta/context';
import { resolveOrganicContext } from './google-organic/context';
import { resolveSalesforceContext } from './salesforce/context';
import { SEARCH_CONSOLE_LAG_DAYS } from './google-organic/sync';
import { parseStageCorrections, parseStageExclusions } from './salesforce/stage-rules';

/**
 * The daily reconciliation: our totals against each source's own.
 *
 * The audit of 23 September 2026 did by hand what this does every day — ask
 * each source for its own totals over the same windows and compare — and found
 * two unread days of Meta, four of calls, 45 merged leads still counted and
 * conversions Google had restated since our last read. None of it was visible
 * on any screen. Each check here is one row in `reconciliation_checks`, and
 * `detail` names what differs: the days, or the records.
 *
 * Read-only against every source. The one write is the check rows, on the
 * ingestion role, scoped to the tenant like any sync.
 *
 * Windows, in the tenant's zone: last calendar month, and this month to
 * yesterday. Today is excluded — it is still happening.
 */
export type CheckStatus = 'match' | 'drift' | 'explained' | 'error';

export type Check = {
  source: string;
  metric: string;
  window: DateRange;
  ours: number | null;
  theirs: number | null;
  tolerance: number;
  status: CheckStatus;
  detail: string | null;
};

export type ReconciliationResult = {
  tenantId: string;
  checks: Check[];
};

const RENEWAL_TYPES_FALLBACK = ['Renewal', 'Renewals', 'Addon', 'Win Back', 'Winback', 'Existing Business'];

function label(days: readonly string[]): string {
  return daySpans(days)
    .map((span) => formatRangeLabel(span))
    .join(', ');
}

function compare(
  source: string,
  metric: string,
  window: DateRange,
  ours: number,
  theirs: number,
  tolerance: number,
  detail: string | null = null,
): Check {
  const within = Math.abs(ours - theirs) <= tolerance;
  return {
    source,
    metric,
    window,
    ours,
    theirs,
    tolerance,
    status: within ? 'match' : 'drift',
    detail: within ? null : detail,
  };
}

/** The windows every source is checked over. */
export function reconciliationWindows(today: string): { key: string; range: DateRange }[] {
  const thisMonth = today.slice(0, 7);
  const windows = [{ key: 'last_month', range: monthRange(previousMonth(thisMonth)) }];
  const yesterday = addDays(today, -1);
  if (yesterday.slice(0, 7) === thisMonth) {
    windows.push({ key: 'month_to_date', range: { start: `${thisMonth}-01`, end: yesterday } });
  }
  return windows;
}

export async function runReconciliation(
  options: { tenantId?: string; now?: Date } = {},
): Promise<ReconciliationResult[]> {
  const now = options.now ?? new Date();
  const tenants = await withMaintenance(getMaintenanceDb(), (tx) =>
    tx
      .select({
        id: schema.tenants.id,
        timezone: schema.tenants.timezone,
        platform: schema.connections.platform,
        connectionId: schema.connections.id,
        status: schema.connections.status,
      })
      .from(schema.connections)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.connections.tenantId)),
  );

  const byTenant = new Map<string, { timezone: string; connections: Map<string, string> }>();
  for (const row of tenants) {
    if (options.tenantId && row.id !== options.tenantId) continue;
    if (row.status === 'not_configured') continue;
    const entry = byTenant.get(row.id) ?? { timezone: row.timezone, connections: new Map() };
    entry.connections.set(row.platform, row.connectionId);
    byTenant.set(row.id, entry);
  }

  const results: ReconciliationResult[] = [];
  for (const [tenantId, { timezone, connections }] of byTenant) {
    const today = tenantDay(now, timezone);
    const windows = reconciliationWindows(today);
    const span: DateRange = { start: windows[0]!.range.start, end: windows.at(-1)!.range.end };
    const checks: Check[] = [];
    const guard = async (source: string, work: () => Promise<void>) => {
      try {
        await work();
      } catch (error) {
        for (const w of windows) {
          checks.push({
            source,
            metric: 'read',
            window: w.range,
            ours: null,
            theirs: null,
            tolerance: 0,
            status: 'error',
            detail: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          });
        }
      }
    };

    // --- Paid media -----------------------------------------------------------
    for (const platform of ['google_ads', 'meta'] as const) {
      const connectionId = connections.get(platform);
      if (!connectionId) continue;
      await guard(platform, async () => {
        const context =
          platform === 'google_ads'
            ? await resolveGoogleAdsContext(tenantId, connectionId)
            : await resolveMetaContext(tenantId, connectionId);
        const rows = await context.connector.fetchDailyMetrics(context.connection, span);
        const theirs = new Map<string, { spend: number; clicks: number; impressions: number; conversions: number }>();
        for (const r of rows) {
          const d = theirs.get(r.date) ?? { spend: 0, clicks: 0, impressions: 0, conversions: 0 };
          d.spend += r.spend;
          d.clicks += r.clicks;
          d.impressions += r.impressions;
          d.conversions += r.platformConversions;
          theirs.set(r.date, d);
        }
        const [oursRows, read] = await withJobTenant(tenantId, async (tx) => [
          await tx
            .select({
              day: sql<string>`to_char(${schema.dailyMetrics.date}, 'YYYY-MM-DD')`,
              spend: sql<string>`coalesce(sum(${schema.dailyMetrics.spend}), 0)`,
              clicks: sql<string>`coalesce(sum(${schema.dailyMetrics.clicks}), 0)`,
              impressions: sql<string>`coalesce(sum(${schema.dailyMetrics.impressions}), 0)`,
              conversions: sql<string>`coalesce(sum(${schema.dailyMetrics.platformConversions}), 0)`,
            })
            .from(schema.dailyMetrics)
            .where(
              and(
                eq(schema.dailyMetrics.tenantId, tenantId),
                eq(schema.dailyMetrics.platform, platform),
                gte(schema.dailyMetrics.date, span.start),
                lte(schema.dailyMetrics.date, span.end),
              ),
            )
            .groupBy(sql`1`),
          await readDays(tx, tenantId, platform, span),
        ] as const);
        const ours = new Map(
          oursRows.map((r) => [
            r.day,
            { spend: Number(r.spend), clicks: Number(r.clicks), impressions: Number(r.impressions), conversions: Number(r.conversions) },
          ]),
        );

        for (const w of windows) {
          const days = eachDay(w.range);
          const sum = (m: Map<string, Record<string, number>>, k: string) =>
            days.reduce((s, d) => s + (m.get(d)?.[k] ?? 0), 0);
          const unread = days.filter((d) => !read.has(d));
          const differing = (k: string, tol: number) =>
            days.filter((d) => Math.abs((ours.get(d)?.[k as 'spend'] ?? 0) - (theirs.get(d)?.[k as 'spend'] ?? 0)) > tol);
          const why = (k: string, tol: number) => {
            const off = differing(k, tol);
            const parts: string[] = [];
            const notRead = off.filter((d) => unread.includes(d));
            const restated = off.filter((d) => !unread.includes(d));
            if (notRead.length) parts.push(`not read ${label(notRead)}`);
            if (restated.length) parts.push(`differs ${label(restated)}`);
            return parts.join('; ') || null;
          };
          const theirConversions = sum(theirs as never, 'conversions');
          checks.push(
            compare(platform, 'spend', w.range, sum(ours as never, 'spend'), sum(theirs as never, 'spend'), 1, why('spend', 0.5)),
            compare(platform, 'clicks', w.range, sum(ours as never, 'clicks'), sum(theirs as never, 'clicks'), 0, why('clicks', 0)),
            compare(platform, 'impressions', w.range, sum(ours as never, 'impressions'), sum(theirs as never, 'impressions'), 0, why('impressions', 0)),
            // Platforms restate conversions for weeks: a small gap is expected
            // and the nightly re-pull closes it.
            compare(
              platform,
              'conversions',
              w.range,
              sum(ours as never, 'conversions'),
              theirConversions,
              Math.max(1, theirConversions * 0.02),
              why('conversions', 0.01),
            ),
          );
        }
      });
    }

    // --- GA4 ------------------------------------------------------------------
    const ga4Connection = connections.get('ga4');
    if (ga4Connection) {
      await guard('ga4', async () => {
        const context = await resolveOrganicContext(tenantId, ga4Connection, 'ga4');
        if (!context.config.propertyId) return;
        const ga4 = ga4Client(context.client, context.config);
        const daily = await ga4.daily(span);
        const theirs = new Map(daily.map((r) => [r.date, r.sessions]));
        const [ours, monthUsers, read] = await withJobTenant(tenantId, async (tx) => [
          await organicDaily(tx, tenantId, 'ga4', span),
          await tx
            .select({ month: schema.ga4Metrics.dimensionValue, users: schema.ga4Metrics.users })
            .from(schema.ga4Metrics)
            .where(and(eq(schema.ga4Metrics.tenantId, tenantId), eq(schema.ga4Metrics.dimension, 'month_users'))),
          await readDays(tx, tenantId, 'ga4', span),
        ] as const);
        for (const w of windows) {
          const days = eachDay(w.range);
          const off = days.filter((d) => (ours.get(d) ?? 0) !== (theirs.get(d) ?? 0));
          const detail = off.length
            ? [
                off.some((d) => !read.has(d)) ? `not read ${label(off.filter((d) => !read.has(d)))}` : null,
                off.some((d) => read.has(d)) ? `differs ${label(off.filter((d) => read.has(d)))}` : null,
              ]
                .filter(Boolean)
                .join('; ')
            : null;
          checks.push(
            compare('ga4', 'sessions', w.range, days.reduce((s, d) => s + (ours.get(d) ?? 0), 0), days.reduce((s, d) => s + (theirs.get(d) ?? 0), 0), 0, detail),
          );
          // GA4's own users for the month the window sits in, over the whole
          // month (to yesterday for this one): the figure the page shows.
          const month = w.range.start.slice(0, 7);
          const whole = monthRange(month);
          const through = whole.end < today ? whole.end : today;
          const theirUsers = (await ga4.periodTotals({ start: whole.start, end: through })).users;
          const stored = monthUsers.find((m) => m.month === month);
          checks.push(
            compare('ga4', 'month_users', w.range, stored ? Number(stored.users) : 0, theirUsers, 0, stored ? 'stored figure is out of date' : 'not stored'),
          );
        }
      });
    }

    // --- Search Console -------------------------------------------------------
    const gscConnection = connections.get('search_console');
    if (gscConnection) {
      await guard('search_console', async () => {
        const context = await resolveOrganicContext(tenantId, gscConnection, 'search_console');
        if (!context.config.siteUrl) return;
        const published = addDays(today, -SEARCH_CONSOLE_LAG_DAYS);
        const clipped: DateRange = { start: span.start, end: span.end < published ? span.end : published };
        const rows = await searchConsoleClient(context.client, context.config).daily(clipped);
        const theirs = new Map(rows.map((r) => [r.date, r]));
        const ours = await withJobTenant(tenantId, (tx) => organicDaily(tx, tenantId, 'search_console', clipped, true));
        for (const w of windows) {
          const end = w.range.end < published ? w.range.end : published;
          if (end < w.range.start) continue;
          const days = eachDay({ start: w.range.start, end });
          for (const metric of ['clicks', 'impressions'] as const) {
            const o = days.reduce((s, d) => s + (metric === 'clicks' ? (ours.get(d) ?? 0) : (ours.impressions?.get(d) ?? 0)), 0);
            const t = days.reduce((s, d) => s + Number(theirs.get(d)?.[metric] ?? 0), 0);
            const off = days.filter(
              (d) => (metric === 'clicks' ? (ours.get(d) ?? 0) : (ours.impressions?.get(d) ?? 0)) !== Number(theirs.get(d)?.[metric] ?? 0),
            );
            checks.push(compare('search_console', metric, { start: w.range.start, end }, o, t, 0, off.length ? `differs ${label(off)}` : null));
          }
        }
      });
    }

    // --- Salesforce -----------------------------------------------------------
    const sfConnection = connections.get('salesforce');
    if (sfConnection) {
      await guard('salesforce', async () => {
        const context = await resolveSalesforceContext(tenantId, sfConnection);
        const config = await withJobTenant(tenantId, (tx) =>
          tx.select().from(schema.tenantConfig).where(eq(schema.tenantConfig.tenantId, tenantId)),
        );
        const byKey = new Map(config.map((c) => [c.key, c.value]));
        const exclusions = parseStageExclusions(byKey.get('stage_exclusions'));
        const renewalTypes = exclusions.find((r) => r.stages.includes('*'))?.dealTypes ?? RENEWAL_TYPES_FALLBACK;
        const corrections = parseStageCorrections(byKey.get('stage_corrections'));
        const typeList = renewalTypes.map((t) => `'${t.replace(/'/g, "\\'")}'`).join(',');
        const notRenewal = `(Type = null OR Type NOT IN (${typeList}))`;
        const inbound = inboundClause(context.leadExclusion ?? NO_LEAD_EXCLUSION);
        const stageFields = context.mapping.stages as Record<string, string>;

        for (const w of windows) {
          const utcStart = parseWallClock(`${w.range.start} 00:00`, timezone)!.toISOString();
          const utcEnd = parseWallClock(`${addDays(w.range.end, 1)} 00:00`, timezone)!.toISOString();
          const inWindow = (field: string) => `${field} >= ${utcStart} AND ${field} < ${utcEnd}`;

          // Leads, counted as the ingest filters them.
          const sfLeads = await context.client.query<{ expr0: number }>(
            `SELECT COUNT(Id) FROM Lead WHERE ${inWindow('CreatedDate')}${inbound ? ` AND (${inbound})` : ''}`,
          );
          const [oursLeads] = await withJobTenant(tenantId, (tx) =>
            tx
              .select({ n: sql<number>`count(*)::int` })
              .from(schema.leads)
              .where(
                and(
                  eq(schema.leads.tenantId, tenantId),
                  gte(schema.leads.createdOn, w.range.start),
                  lte(schema.leads.createdOn, w.range.end),
                  sql`${schema.leads.excludedReason} is null or ${schema.leads.excludedReason} = 'renewal'`,
                ),
              ),
          );
          // Salesforce counts a renewal's lead as a lead; ours excludes it by
          // decision, so the comparison adds those back rather than calling a
          // documented exclusion drift.
          checks.push(compare('salesforce', 'leads', w.range, Number(oursLeads?.n ?? 0), Number(sfLeads[0]?.expr0 ?? 0), 0, 'lead counts differ'));

          // Opportunity stages, by record: a difference that a recorded
          // correction explains is `explained`, anything else is drift.
          const stages: [string, string][] = [
            ['application', 'CreatedDate'],
            ...Object.entries(stageFields).filter(([, field]) => typeof field === 'string'),
          ];
          for (const [stage, field] of stages) {
            const theirIds = new Set(
              (
                await context.client.query<{ Id: string }>(
                  `SELECT Id FROM Opportunity WHERE ${inWindow(field)} AND ${notRenewal}`,
                )
              ).map((r) => r.Id),
            );
            const ourIds = new Set(
              (
                await withJobTenant(tenantId, (tx) =>
                  tx
                    .selectDistinct({ id: schema.stageEvents.opportunityExternalId })
                    .from(schema.stageEvents)
                    .where(
                      and(
                        eq(schema.stageEvents.tenantId, tenantId),
                        eq(schema.stageEvents.stage, stage),
                        gte(schema.stageEvents.occurredOn, w.range.start),
                        lte(schema.stageEvents.occurredOn, w.range.end),
                        sql`${schema.stageEvents.excludedReason} is null`,
                      ),
                    ),
                )
              ).map((r) => r.id),
            );
            checks.push(classifyIds('salesforce', stage, w.range, ourIds, theirIds, corrections));
          }

          // Stages read from field history rather than a field — UW approved
          // in this org — by the same aliases the ingest maps.
          const historyStages = [...new Set(Object.values(STAGE_NAME_ALIASES).filter((v): v is string => !!v))]
            .filter((stage) => !stages.some(([s]) => s === stage) && stage !== 'declined');
          if (historyStages.length > 0) {
            const history = await context.client.query<{
              OpportunityId: string;
              NewValue: string | null;
              Opportunity: { Type: string | null } | null;
            }>(
              `SELECT OpportunityId, NewValue, Opportunity.Type FROM OpportunityFieldHistory WHERE Field = 'StageName' AND ${inWindow('CreatedDate')}`,
            );
            const renewal = new Set(renewalTypes.map((t) => t.trim().toLowerCase()));
            for (const stage of historyStages) {
              const theirIds = new Set(
                history
                  .filter((h) => STAGE_NAME_ALIASES[String(h.NewValue ?? '').trim().toLowerCase()] === stage)
                  .filter((h) => !renewal.has(String(h.Opportunity?.Type ?? '').trim().toLowerCase()))
                  .map((h) => h.OpportunityId),
              );
              const ourIds = new Set(
                (
                  await withJobTenant(tenantId, (tx) =>
                    tx
                      .selectDistinct({ id: schema.stageEvents.opportunityExternalId })
                      .from(schema.stageEvents)
                      .where(
                        and(
                          eq(schema.stageEvents.tenantId, tenantId),
                          eq(schema.stageEvents.stage, stage),
                          gte(schema.stageEvents.occurredOn, w.range.start),
                          lte(schema.stageEvents.occurredOn, w.range.end),
                          sql`${schema.stageEvents.excludedReason} is null`,
                        ),
                      ),
                  )
                ).map((r) => r.id),
              );
              checks.push(classifyIds('salesforce', stage, w.range, ourIds, theirIds, corrections));
            }
          }
        }
      });
    }

    // --- Calls ----------------------------------------------------------------
    await guard('call_tracking', async () => {
      const [stored, deliveries] = await withJobTenant(tenantId, async (tx) => [
        await tx
          .select({
            day: sql<string>`to_char(${schema.calls.occurredOn}, 'YYYY-MM-DD')`,
            all: sql<number>`count(*)::int`,
            webhook: sql<number>`count(*) filter (where ${schema.calls.source} = 'webhook')::int`,
          })
          .from(schema.calls)
          .where(and(eq(schema.calls.tenantId, tenantId), gte(schema.calls.occurredOn, span.start), lte(schema.calls.occurredOn, span.end)))
          .groupBy(sql`1`),
        await tx
          .select({ day: sql<string>`to_char(${schema.webhookDeliveries.day}, 'YYYY-MM-DD')`, accepted: schema.webhookDeliveries.accepted })
          .from(schema.webhookDeliveries)
          .where(and(eq(schema.webhookDeliveries.tenantId, tenantId), gte(schema.webhookDeliveries.day, span.start), lte(schema.webhookDeliveries.day, span.end))),
      ] as const);
      if (stored.length === 0 && deliveries.length === 0) return;
      const perDay = new Map(stored.map((r) => [r.day, r]));
      for (const w of windows) {
        const days = eachDay(w.range);
        const weekdays = days.filter((d) => {
          const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
          return dow !== 0 && dow !== 6;
        });
        const silent = weekdays.filter((d) => !perDay.get(d)?.all);
        const accepted = deliveries.filter((d) => d.day >= w.range.start && d.day <= w.range.end).reduce((s, d) => s + d.accepted, 0);
        const viaWebhook = days.reduce((s, d) => s + (perDay.get(d)?.webhook ?? 0), 0);
        // A weekday with no call at all is a feed that was down, not a quiet desk.
        checks.push({
          source: 'call_tracking',
          metric: 'weekdays_with_calls',
          window: w.range,
          ours: weekdays.length - silent.length,
          theirs: weekdays.length,
          tolerance: 0,
          status: silent.length ? 'drift' : 'match',
          detail: silent.length ? `no calls recorded ${label(silent)}` : null,
        });
        if (accepted > 0 || viaWebhook > 0) {
          checks.push(compare('call_tracking', 'webhook_calls', w.range, viaWebhook, accepted, Math.max(2, accepted * 0.02), 'stored webhook calls differ from deliveries accepted'));
        }
      }
    });

    await withJobTenant(tenantId, (tx) => writeChecks(tx, tenantId, checks, now));
    results.push({ tenantId, checks });
  }
  return results;
}

function classifyIds(
  source: string,
  stage: string,
  window: DateRange,
  ours: Set<string>,
  theirs: Set<string>,
  corrections: { opportunity: string; stage: string; month: string }[],
): Check {
  const onlyOurs = [...ours].filter((id) => !theirs.has(id));
  const onlyTheirs = [...theirs].filter((id) => !ours.has(id));
  const corrected = new Set(corrections.filter((c) => c.stage === stage).map((c) => c.opportunity));
  const unexplained = [...onlyOurs, ...onlyTheirs].filter((id) => !corrected.has(id));
  const explained = [...onlyOurs, ...onlyTheirs].filter((id) => corrected.has(id));
  const status: CheckStatus =
    unexplained.length > 0 ? 'drift' : explained.length > 0 ? 'explained' : 'match';
  const parts: string[] = [];
  if (explained.length) parts.push(`${explained.length} moved by a recorded correction (${explained.join(', ')})`);
  if (onlyTheirs.filter((id) => !corrected.has(id)).length) {
    parts.push(`${onlyTheirs.filter((id) => !corrected.has(id)).length} in Salesforce not counted here`);
  }
  if (onlyOurs.filter((id) => !corrected.has(id)).length) {
    parts.push(`${onlyOurs.filter((id) => !corrected.has(id)).length} counted here not in Salesforce`);
  }
  return {
    source,
    metric: stage,
    window,
    ours: ours.size,
    theirs: theirs.size,
    tolerance: 0,
    status,
    detail: parts.length ? parts.join('; ') : null,
  };
}

async function readDays(tx: Database, tenantId: string, platform: string, range: DateRange): Promise<Set<string>> {
  const rows = await tx
    .select({ day: sql<string>`to_char(${schema.syncDays.day}, 'YYYY-MM-DD')` })
    .from(schema.syncDays)
    .where(
      and(
        eq(schema.syncDays.tenantId, tenantId),
        eq(schema.syncDays.platform, platform),
        gte(schema.syncDays.day, range.start),
        lte(schema.syncDays.day, range.end),
      ),
    );
  return new Set(rows.map((r) => r.day));
}

async function organicDaily(
  tx: Database,
  tenantId: string,
  kind: 'ga4' | 'search_console',
  range: DateRange,
  withImpressions = false,
): Promise<Map<string, number> & { impressions?: Map<string, number> }> {
  const table = kind === 'ga4' ? schema.ga4Metrics : schema.searchConsoleMetrics;
  const primary = kind === 'ga4' ? schema.ga4Metrics.sessions : schema.searchConsoleMetrics.clicks;
  const rows = await tx
    .select({
      day: sql<string>`to_char(${table.date}, 'YYYY-MM-DD')`,
      primary: sql<string>`coalesce(sum(${primary}), 0)`,
      impressions: withImpressions
        ? sql<string>`coalesce(sum(${schema.searchConsoleMetrics.impressions}), 0)`
        : sql<string>`'0'`,
    })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), eq(table.dimension, 'total'), gte(table.date, range.start), lte(table.date, range.end)))
    .groupBy(sql`1`);
  const out = new Map(rows.map((r) => [r.day, Number(r.primary)])) as Map<string, number> & {
    impressions?: Map<string, number>;
  };
  if (withImpressions) out.impressions = new Map(rows.map((r) => [r.day, Number(r.impressions)]));
  return out;
}

async function writeChecks(tx: Database, tenantId: string, checks: Check[], now: Date): Promise<void> {
  if (checks.length === 0) return;
  await tx
    .insert(schema.reconciliationChecks)
    .values(
      checks.map((c) => ({
        tenantId,
        source: c.source,
        metric: c.metric,
        windowStart: c.window.start,
        windowEnd: c.window.end,
        ours: c.ours === null ? null : String(c.ours),
        theirs: c.theirs === null ? null : String(c.theirs),
        difference: c.ours === null || c.theirs === null ? null : String(c.ours - c.theirs),
        tolerance: String(c.tolerance),
        status: c.status,
        detail: c.detail,
        checkedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [
        schema.reconciliationChecks.tenantId,
        schema.reconciliationChecks.source,
        schema.reconciliationChecks.metric,
        schema.reconciliationChecks.windowStart,
        schema.reconciliationChecks.windowEnd,
      ],
      set: {
        ours: sql`excluded.ours`,
        theirs: sql`excluded.theirs`,
        difference: sql`excluded.difference`,
        tolerance: sql`excluded.tolerance`,
        status: sql`excluded.status`,
        detail: sql`excluded.detail`,
        checkedAt: sql`excluded.checked_at`,
      },
    });
}
