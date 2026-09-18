import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { schema, type Database } from '@zeeraa/db';
import {
  channelCostPerDeal,
  previousMonth,
  type AttributionModel,
  type ChannelCostPerDeal,
  type DateRange,
  type StageDefinition,
} from '@zeeraa/core';
import { queryTenant, type TenantSession } from '@/lib/tenant';

/**
 * Read queries behind the reporting screens.
 *
 * The row types here are the separation rule expressed in TypeScript. A channel
 * row and the unattributed row are different shapes, not one shape with some
 * nulls, so a component cannot put them on the same line by iterating a list —
 * it has to decide what to render for each kind, and the compiler makes it.
 *
 * Specifically: `UnattributedRow` has no `spend` and no `costPerDeal` fields at
 * all. Not zero, not null — absent. Nobody bought those deals, and a spend
 * column reading 0 against fifteen funded deals is a measurement claiming
 * Zeeraa acquired them for nothing.
 */

export const PLATFORM_LABELS: Record<string, string> = {
  salesforce: 'Salesforce',
  google_ads: 'Google Ads',
  microsoft_ads: 'Microsoft Ads',
  meta: 'Meta',
  linkedin_ads: 'LinkedIn Ads',
  ga4: 'GA4',
  search_console: 'Search Console',
  semrush: 'Semrush',
  call_tracking: 'Call tracking',
};

/**
 * Stages whose only source is `OpportunityFieldHistory`.
 *
 * `uw_approved` has a mapped field, `csbs__Approved_Date_Time__c`, that is
 * empty on every opportunity in the org, so the transitions in field history
 * are the whole of its evidence — and its horizon is therefore the stage's.
 * `declined` has both a stamped field and history, so it is not listed: the
 * field reaches further back than tracking does.
 */
const HISTORY_SOURCED_STAGES = new Set(['uw_approved']);

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

/** Counts per configured stage, keyed by stage key. */
export type StageCounts = Record<string, number>;

/**
 * What a stage column is allowed to say.
 *
 * A stage nobody stamps in the CRM has not been measured, and a zero in its
 * column is a measurement — it says no deal reached it. `blocked` carries the
 * dependency so the column renders the reason instead of the number, on the
 * same mechanism as the funnel view. `computed` marks a stage the platform
 * inferred rather than one the CRM recorded; the two are different kinds of
 * fact and must not be presented identically.
 */
export type StageStatus = {
  key: string;
  blocked: { label: string; reason: string; needed: string | null; since: Date } | null;
  origin: 'observed' | 'computed';
  /**
   * A horizon on the source, where one exists.
   *
   * UW approved is read from Salesforce field history, which begins when
   * tracking was switched on and ages out by retention. The transitions inside
   * that window are observed facts; approvals before it are not absent, they
   * are unreadable — and a rate computed across a period that predates the
   * window understates it. So the limit travels with the stage rather than
   * being something to discover later.
   *
   * Measured on every sync, so it rolls forward as retention expires rows.
   */
  coverage: { from: Date; source: string } | null;
};

export type ChannelRow = {
  kind: 'channel';
  platform: string;
  label: string;
  spend: number;
  impressions: number;
  clicks: number;
  /** Null rather than zero when there were no impressions to divide by. */
  ctr: number | null;
  cpc: number | null;
  /** Opportunities attributed to this channel, by stage. */
  stages: StageCounts;
  /** Funded amount on deals attributed to this channel. */
  valueVolume: number;
  costPerDeal: ChannelCostPerDeal;
};

/**
 * Deals no channel can claim.
 *
 * Deliberately not a `ChannelRow` with zeroes. It has no spend, no CTR, no CPC
 * and no cost per deal — those are not missing values, they are questions that
 * do not apply. The table renders an em dash and a reason in those columns.
 */
export type UnattributedRow = {
  kind: 'unattributed';
  label: string;
  stages: StageCounts;
  valueVolume: number;
  /** Why these cannot be costed, in the interface's voice. */
  reason: string;
};

/**
 * The totals line.
 *
 * Sums only what is summable. Spend adds across channels; deals add across every
 * source, attributed or not, because that is the business's real total. Cost per
 * deal does not add, and is not one total divided by the other either — that is
 * blended cost per funded deal, a different metric with its own denominator
 * which does not mean anything until every channel is ingested. So the field is
 * a stated absence rather than a number.
 */
export type TotalRow = {
  kind: 'total';
  label: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cpc: number | null;
  stages: StageCounts;
  valueVolume: number;
  costPerDeal: null;
  costPerDealAbsentBecause: string;
};

export type PerformanceRow = ChannelRow | UnattributedRow | TotalRow;

export type MonthlyPerformance = {
  range: DateRange;
  model: AttributionModel;
  stages: StageDefinition[];
  /** Per stage: whether it is measurable at all, and how it was established. */
  stageStatus: Record<string, StageStatus>;
  /** Which stage counts as value for this tenant, from configuration. */
  valueStageKey: string | null;
  channels: ChannelRow[];
  unattributed: UnattributedRow;
  total: TotalRow;
  /** Completion time of the most recent sync feeding this. Null when none has run. */
  dataThrough: Date | null;
  /**
   * Declines in the window.
   *
   * `deals` is distinct opportunities; `events` is transitions into the stage.
   * They are both here because they are different facts and the difference is
   * the interesting part: a deal can be declined, revived and declined again,
   * so `events` above `deals` is re-underwriting rather than a data error.
   * Declined is not a funnel stage — it is an outcome, not a step — so it has
   * no column in `stages`.
   */
  declines: { deals: number; events: number };
  /**
   * How much of the qualification bar could be evaluated, over the leads in
   * this window.
   *
   * MQL is a computed stage, and its count is only as meaningful as the share
   * of the population the bar could actually be run against. The inputs arrive
   * as bands, and a band containing the threshold resolves to neither answer —
   * so the count must never render without this beside it.
   */
  qualification: {
    total: number;
    qualified: number;
    unqualified: number;
    undeterminable: number;
    /**
     * Leads carrying no verdict at all.
     *
     * Distinct from `undeterminable`, which is a verdict: the bar ran and the
     * answer spans the threshold. This is the bar never having run — a lead
     * ingested before the verdict column existed, or between a change to the
     * bar and the re-evaluation. It is not assessable either, so it stays in
     * `total` and out of `coverage`, but it must not be described as a band
     * problem, because the fix is a re-sync rather than a form field.
     */
    unevaluated: number;
    /** Determinable share of the population. */
    coverage: number | null;
    /** The most common obstruction, for the note. */
    topReason: string | null;
  };
};

const BLENDED_NOT_COMPUTED =
  'Blended cost per funded deal is a different metric — total marketing spend ' +
  'over total marketing-sourced deals — and needs every channel ingested before ' +
  'it means anything. With one channel live it would be that channel’s figure ' +
  'under a broader name.';

const UNATTRIBUTED_REASON =
  'These deals carry no click from any connected channel. They came from ' +
  'organic, referral, outbound and repeat business as well as, possibly, paid ' +
  'media that was never tagged. Nothing in the data says which, so no channel ' +
  'may count them and no spend stands behind them.';

export async function monthlyPerformance(
  session: TenantSession,
  range: DateRange,
  model: AttributionModel = 'last_touch',
): Promise<MonthlyPerformance> {
  return queryTenant(session, async (tx) => {
    const tenantId = session.tenant.id;

    const stages = await tx
      .select()
      .from(schema.funnelStages)
      .where(eq(schema.funnelStages.tenantId, tenantId))
      .orderBy(asc(schema.funnelStages.position));

    const valueStage = stages.find((s) => s.countsValue)?.key ?? null;

    const blockedRows = await tx
      .select()
      .from(schema.blockedDependencies)
      .where(
        and(
          eq(schema.blockedDependencies.tenantId, tenantId),
          eq(schema.blockedDependencies.subjectKind, 'funnel_stage'),
        ),
      );
    const blockedByStage = new Map(blockedRows.map((b) => [b.subjectKey, b]));

    // How each stage's timestamps were established. A stage whose events are
    // computed is marked as computed everywhere it renders.
    const originRows = await tx
      .select({ stage: schema.stageEvents.stage, origin: schema.stageEvents.origin })
      .from(schema.stageEvents)
      .where(eq(schema.stageEvents.tenantId, tenantId))
      .groupBy(schema.stageEvents.stage, schema.stageEvents.origin);
    const computedStages = new Set(
      originRows.filter((r) => r.origin === 'computed').map((r) => r.stage),
    );

    /**
     * Stages measured at lead grain, counted from `leads` rather than from
     * stage events.
     *
     * A lead that never became an opportunity has no opportunity to attribute
     * through, so the channel comes from `leads.click_id_type` directly. The
     * population is already inbound — cold outreach is excluded at ingest — so
     * nothing here re-filters it.
     */
    const leadStages = stages.filter(
      (s) => s.source === 'leads' || s.source === 'qualified_leads',
    );
    /** Per lead-grain stage: attributed counts by platform, and the rest. */
    const leadCounts = new Map<
      string,
      { byPlatform: Map<string, number>; unattributed: number }
    >();

    for (const stage of leadStages) {
      /*
       * `qualified_leads` is the same population narrowed to leads that pass
       * the bar. It is a separate source rather than a filter applied later
       * because the grain is the point: a qualified lead is a property of a
       * *lead*, and counting it from `stage_events` would count only the ones
       * that went on to become opportunities — a different, much smaller
       * number wearing the name MQL, and the numerator of a rate whose
       * denominator is every lead.
       */
      const rows = await tx
        .select({
          clickIdType: schema.leads.clickIdType,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.leads)
        .where(
          and(
            eq(schema.leads.tenantId, tenantId),
            gte(schema.leads.createdAt, new Date(`${range.start}T00:00:00.000Z`)),
            lte(schema.leads.createdAt, new Date(`${range.end}T23:59:59.999Z`)),
            ...(stage.source === 'qualified_leads'
              ? [eq(schema.leads.mqlVerdict, 'qualified')]
              : []),
          ),
        )
        .groupBy(schema.leads.clickIdType);

      const byPlatformCounts = new Map<string, number>();
      let unattributed = 0;
      for (const row of rows) {
        if (row.clickIdType) {
          byPlatformCounts.set(
            row.clickIdType,
            (byPlatformCounts.get(row.clickIdType) ?? 0) + Number(row.count),
          );
        } else {
          unattributed += Number(row.count);
        }
      }
      leadCounts.set(stage.key, { byPlatform: byPlatformCounts, unattributed });
    }

    const spendRows = await tx
      .select({
        platform: schema.dailyMetrics.platform,
        spend: sql<string>`coalesce(sum(${schema.dailyMetrics.spend}), 0)`,
        impressions: sql<string>`coalesce(sum(${schema.dailyMetrics.impressions}), 0)`,
        clicks: sql<string>`coalesce(sum(${schema.dailyMetrics.clicks}), 0)`,
      })
      .from(schema.dailyMetrics)
      .where(
        and(
          eq(schema.dailyMetrics.tenantId, tenantId),
          gte(schema.dailyMetrics.date, range.start),
          lte(schema.dailyMetrics.date, range.end),
        ),
      )
      .groupBy(schema.dailyMetrics.platform);

    // One row per (stage, opportunity, attributed platform). Distinct because a
    // stage can recur — a deal that funds twice is one deal.
    const stageRows = await tx
      .selectDistinct({
        stage: schema.stageEvents.stage,
        opportunityExternalId: schema.stageEvents.opportunityExternalId,
        platform: schema.attribution.platform,
      })
      .from(schema.stageEvents)
      .leftJoin(
        schema.attribution,
        and(
          eq(schema.attribution.tenantId, schema.stageEvents.tenantId),
          eq(schema.attribution.opportunityExternalId, schema.stageEvents.opportunityExternalId),
          eq(schema.attribution.model, model),
        ),
      )
      .where(
        and(
          eq(schema.stageEvents.tenantId, tenantId),
          gte(schema.stageEvents.occurredAt, new Date(`${range.start}T00:00:00.000Z`)),
          lte(schema.stageEvents.occurredAt, new Date(`${range.end}T23:59:59.999Z`)),
        ),
      );

    // Funded amount per opportunity, for the value-volume column.
    const valueIds = valueStage
      ? [
          ...new Set(
            stageRows.filter((r) => r.stage === valueStage).map((r) => r.opportunityExternalId),
          ),
        ]
      : [];
    const amounts = new Map<string, number>();
    if (valueIds.length > 0) {
      const rows = await tx
        .select({
          externalId: schema.opportunities.externalId,
          fundedAmount: schema.opportunities.fundedAmount,
          amount: schema.opportunities.amount,
        })
        .from(schema.opportunities)
        .where(
          and(
            eq(schema.opportunities.tenantId, tenantId),
            inArray(schema.opportunities.externalId, valueIds),
          ),
        );
      for (const row of rows) {
        amounts.set(row.externalId, Number(row.fundedAmount ?? row.amount ?? 0));
      }
    }

    // The window each windowed source can speak for, keyed as `window:*` by
    // `recordSourceWindow`.
    const windowRows = await tx
      .select({ factKey: schema.dataSources.factKey, asOf: schema.dataSources.asOf })
      .from(schema.dataSources)
      .where(eq(schema.dataSources.tenantId, tenantId));
    const stageHistoryWindow =
      windowRows.find((r) => r.factKey === 'window:salesforce:stage_history')?.asOf ?? null;

    /**
     * The bar's verdicts over the leads created in this window.
     *
     * Lead grain on purpose: this is the share of the *population* the bar
     * could be evaluated against, which is what qualifies the MQL count. The
     * stage count itself is opportunity grain, and mixing the two would be the
     * denominator error this codebase keeps guarding against — so they render
     * as two facts, not as one ratio.
     */
    const verdictRows = await tx
      .select({
        verdict: schema.leads.mqlVerdict,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.leads)
      .where(
        and(
          eq(schema.leads.tenantId, tenantId),
          gte(schema.leads.createdAt, new Date(`${range.start}T00:00:00.000Z`)),
          lte(schema.leads.createdAt, new Date(`${range.end}T23:59:59.999Z`)),
        ),
      )
      .groupBy(schema.leads.mqlVerdict);

    const [declineRow] = await tx
      .select({
        deals: sql<number>`count(distinct ${schema.stageEvents.opportunityExternalId})::int`,
        events: sql<number>`count(*)::int`,
      })
      .from(schema.stageEvents)
      .where(
        and(
          eq(schema.stageEvents.tenantId, tenantId),
          eq(schema.stageEvents.stage, 'declined'),
          gte(schema.stageEvents.occurredAt, new Date(`${range.start}T00:00:00.000Z`)),
          lte(schema.stageEvents.occurredAt, new Date(`${range.end}T23:59:59.999Z`)),
        ),
      );

    const [topReasonRow] = await tx
      .select({
        reason: schema.leads.mqlUndeterminableReason,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.leads)
      .where(
        and(
          eq(schema.leads.tenantId, tenantId),
          eq(schema.leads.mqlVerdict, 'undeterminable'),
          gte(schema.leads.createdAt, new Date(`${range.start}T00:00:00.000Z`)),
          lte(schema.leads.createdAt, new Date(`${range.end}T23:59:59.999Z`)),
        ),
      )
      .groupBy(schema.leads.mqlUndeterminableReason)
      .orderBy(sql`count(*) desc`)
      .limit(1);

    const verdictCount = (key: string) =>
      Number(verdictRows.find((r) => r.verdict === key)?.count ?? 0);
    const qualified = verdictCount('qualified');
    const unqualified = verdictCount('unqualified');
    const undeterminable = verdictCount('undeterminable');
    const verdictTotal = verdictRows.reduce((sum, r) => sum + Number(r.count), 0);

    const [latestSync] = await tx
      .select({ finishedAt: schema.syncRuns.finishedAt })
      .from(schema.syncRuns)
      .where(and(eq(schema.syncRuns.tenantId, tenantId), eq(schema.syncRuns.status, 'succeeded')))
      .orderBy(sql`${schema.syncRuns.finishedAt} desc nulls last`)
      .limit(1);

    // --- Fold the stage rows into populations -------------------------------
    // A deal belongs to exactly one bucket per stage: a named channel, or
    // nobody. There is deliberately no path that puts it in both.
    const byPlatform = new Map<string, StageCounts>();
    const unattributedStages: StageCounts = {};
    const valueDealsByPlatform = new Map<string, Set<string>>();
    const unattributedValueDeals = new Set<string>();

    for (const row of stageRows) {
      const target = row.platform
        ? (byPlatform.get(row.platform) ?? byPlatform.set(row.platform, {}).get(row.platform)!)
        : unattributedStages;
      target[row.stage] = (target[row.stage] ?? 0) + 1;

      if (valueStage && row.stage === valueStage) {
        if (row.platform) {
          const set = valueDealsByPlatform.get(row.platform) ?? new Set<string>();
          set.add(row.opportunityExternalId);
          valueDealsByPlatform.set(row.platform, set);
        } else {
          unattributedValueDeals.add(row.opportunityExternalId);
        }
      }
    }

    for (const stage of leadStages) {
      const counts = leadCounts.get(stage.key);
      if (!counts) continue;
      for (const [platform, count] of counts.byPlatform) {
        const target = byPlatform.get(platform) ?? byPlatform.set(platform, {}).get(platform)!;
        target[stage.key] = count;
      }
      unattributedStages[stage.key] = counts.unattributed;
    }

    const sumAmounts = (ids: Iterable<string>) =>
      [...ids].reduce((sum, id) => sum + (amounts.get(id) ?? 0), 0);

    // Every platform that has either spend or attributed deals in the window.
    const platforms = [
      ...new Set([
        ...spendRows.map((r) => r.platform),
        ...byPlatform.keys(),
        ...[...leadCounts.values()].flatMap((c) => [...c.byPlatform.keys()]),
      ]),
    ].sort((a, b) => platformLabel(a).localeCompare(platformLabel(b)));

    const unattributedDealCount = unattributedValueDeals.size;

    const channels: ChannelRow[] = platforms.map((platform) => {
      const spendRow = spendRows.find((r) => r.platform === platform);
      const spend = Number(spendRow?.spend ?? 0);
      const impressions = Number(spendRow?.impressions ?? 0);
      const clicks = Number(spendRow?.clicks ?? 0);
      const attributedDeals = valueDealsByPlatform.get(platform)?.size ?? 0;
      const dealsElsewhere = [...valueDealsByPlatform.entries()]
        .filter(([key]) => key !== platform)
        .reduce((sum, [, set]) => sum + set.size, 0);

      return {
        kind: 'channel',
        platform,
        label: platformLabel(platform),
        spend,
        impressions,
        clicks,
        ctr: impressions === 0 ? null : clicks / impressions,
        cpc: clicks === 0 ? null : spend / clicks,
        stages: byPlatform.get(platform) ?? {},
        valueVolume: sumAmounts(valueDealsByPlatform.get(platform) ?? []),
        costPerDeal: channelCostPerDeal({
          channelSpend: spend,
          attributedDeals,
          unattributedDeals: unattributedDealCount,
          dealsAttributedElsewhere: dealsElsewhere,
        }),
      };
    });

    const totalSpend = channels.reduce((sum, c) => sum + c.spend, 0);
    const totalImpressions = channels.reduce((sum, c) => sum + c.impressions, 0);
    const totalClicks = channels.reduce((sum, c) => sum + c.clicks, 0);

    const totalStages: StageCounts = {};
    for (const stage of stages) {
      totalStages[stage.key] =
        channels.reduce((sum, c) => sum + (c.stages[stage.key] ?? 0), 0) +
        (unattributedStages[stage.key] ?? 0);
    }

    return {
      range,
      model,
      stages: stages.map((s) => ({
        key: s.key,
        label: s.label,
        position: s.position,
        isOptimizationTarget: s.isOptimizationTarget,
        countsValue: s.countsValue,
        source: s.source,
      })),
      stageStatus: Object.fromEntries(
        stages.map((stage) => {
          const block = blockedByStage.get(stage.key);
          return [
            stage.key,
            {
              key: stage.key,
              blocked: block
                ? {
                    label: block.label,
                    reason: block.reason,
                    needed: block.needed,
                    since: block.blockedSince,
                  }
                : null,
              origin: computedStages.has(stage.key) ? 'computed' : 'observed',
              // Only the stages with no stamped field of their own are read
              // from history, so only they carry its horizon.
              coverage:
                stageHistoryWindow && HISTORY_SOURCED_STAGES.has(stage.key)
                  ? { from: stageHistoryWindow, source: 'Salesforce field history' }
                  : null,
            } satisfies StageStatus,
          ];
        }),
      ),
      valueStageKey: valueStage,
      channels,
      unattributed: {
        kind: 'unattributed',
        label: 'Unattributed',
        stages: unattributedStages,
        valueVolume: sumAmounts(unattributedValueDeals),
        reason: UNATTRIBUTED_REASON,
      },
      total: {
        kind: 'total',
        label: 'Total',
        spend: totalSpend,
        impressions: totalImpressions,
        clicks: totalClicks,
        ctr: totalImpressions === 0 ? null : totalClicks / totalImpressions,
        cpc: totalClicks === 0 ? null : totalSpend / totalClicks,
        stages: totalStages,
        valueVolume:
          channels.reduce((sum, c) => sum + c.valueVolume, 0) + sumAmounts(unattributedValueDeals),
        costPerDeal: null,
        costPerDealAbsentBecause: BLENDED_NOT_COMPUTED,
      },
      dataThrough: latestSync?.finishedAt ?? null,
      declines: {
        deals: Number(declineRow?.deals ?? 0),
        events: Number(declineRow?.events ?? 0),
      },
      qualification: {
        total: verdictTotal,
        qualified,
        unqualified,
        undeterminable,
        unevaluated: verdictTotal - qualified - unqualified - undeterminable,
        coverage: verdictTotal === 0 ? null : (qualified + unqualified) / verdictTotal,
        topReason: topReasonRow?.reason ?? null,
      },
    };
  });
}

/**
 * One point per calendar month, per channel, for the trend charts.
 *
 * Spend and deals are kept as separate measures on the same month rather than
 * combined into a ratio here: a cost per deal for a month with one funded deal
 * is a number the chart should not draw as though it were comparable to a month
 * with twenty, and the decision about how to present that belongs to the chart,
 * not to the query.
 *
 * `unattributedDeals` travels per month for the same reason it travels in the
 * table — it is a separate population, and a trend line that quietly absorbed
 * it would drift for reasons that have nothing to do with the channel.
 */
export type MonthPoint = {
  month: string;
  label: string;
  /** Per platform: spend and deals attributed to it that month. */
  byPlatform: Record<string, { spend: number; deals: number }>;
  unattributedDeals: number;
  totalDeals: number;
  totalSpend: number;
  /**
   * Whether this month is inside the ingested record at all.
   *
   * A month before the first sync has no spend and no deals, but it does not
   * have zero of either — nobody looked. Charts plot null for these rather than
   * 0, because a line dropping to the axis says the spend stopped, which is a
   * measurement and in this case a false one.
   */
  ingested: boolean;
};

export async function monthlySeries(
  session: TenantSession,
  months: number,
  model: AttributionModel = 'last_touch',
  today = new Date(),
): Promise<MonthPoint[]> {
  return queryTenant(session, async (tx) => {
    const tenantId = session.tenant.id;

    const [valueStageRow] = await tx
      .select({ key: schema.funnelStages.key })
      .from(schema.funnelStages)
      .where(
        and(eq(schema.funnelStages.tenantId, tenantId), eq(schema.funnelStages.countsValue, true)),
      )
      .limit(1);
    const valueStage = valueStageRow?.key ?? null;

    const end = today.toISOString().slice(0, 7);
    const keys: string[] = [];
    let cursor = end;
    for (let i = 0; i < months; i += 1) {
      keys.unshift(cursor);
      cursor = previousMonth(cursor);
    }
    const from = `${keys[0]}-01`;

    const spendRows = await tx
      .select({
        month: sql<string>`to_char(${schema.dailyMetrics.date}, 'YYYY-MM')`,
        platform: schema.dailyMetrics.platform,
        spend: sql<string>`coalesce(sum(${schema.dailyMetrics.spend}), 0)`,
      })
      .from(schema.dailyMetrics)
      .where(and(eq(schema.dailyMetrics.tenantId, tenantId), gte(schema.dailyMetrics.date, from)))
      .groupBy(sql`1`, schema.dailyMetrics.platform);

    const dealRows = valueStage
      ? await tx
          .selectDistinct({
            month: sql<string>`to_char(${schema.stageEvents.occurredAt}, 'YYYY-MM')`,
            platform: schema.attribution.platform,
            opportunityExternalId: schema.stageEvents.opportunityExternalId,
          })
          .from(schema.stageEvents)
          .leftJoin(
            schema.attribution,
            and(
              eq(schema.attribution.tenantId, schema.stageEvents.tenantId),
              eq(
                schema.attribution.opportunityExternalId,
                schema.stageEvents.opportunityExternalId,
              ),
              eq(schema.attribution.model, model),
            ),
          )
          .where(
            and(
              eq(schema.stageEvents.tenantId, tenantId),
              eq(schema.stageEvents.stage, valueStage),
              gte(schema.stageEvents.occurredAt, new Date(`${from}T00:00:00.000Z`)),
            ),
          )
      : [];

    // The earliest month anything was actually ingested for. Everything before
    // it is absent from the record rather than zero in it.
    const observedMonths = new Set([
      ...spendRows.map((r) => r.month),
      ...dealRows.map((r) => r.month),
    ]);
    const firstObserved = [...observedMonths].sort()[0];

    return keys.map((month) => {
      const byPlatform: Record<string, { spend: number; deals: number }> = {};
      for (const row of spendRows.filter((r) => r.month === month)) {
        const entry = (byPlatform[row.platform] ??= { spend: 0, deals: 0 });
        entry.spend += Number(row.spend);
      }

      const inMonth = dealRows.filter((r) => r.month === month);
      let unattributedDeals = 0;
      for (const row of inMonth) {
        if (row.platform) {
          const entry = (byPlatform[row.platform] ??= { spend: 0, deals: 0 });
          entry.deals += 1;
        } else {
          unattributedDeals += 1;
        }
      }

      const [year, m] = month.split('-');
      return {
        month,
        label: new Date(Date.UTC(Number(year), Number(m) - 1, 1)).toLocaleDateString('en-US', {
          month: 'short',
          year: '2-digit',
          timeZone: 'UTC',
        }),
        byPlatform,
        unattributedDeals,
        totalDeals: inMonth.length,
        totalSpend: Object.values(byPlatform).reduce((sum, p) => sum + p.spend, 0),
        ingested: firstObserved !== undefined && month >= firstObserved,
      };
    });
  });
}
