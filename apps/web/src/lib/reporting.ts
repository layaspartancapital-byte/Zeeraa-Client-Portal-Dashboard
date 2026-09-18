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
    const leadStages = stages.filter((s) => s.source === 'leads');
    const leadCountsByPlatform = new Map<string, number>();
    let unattributedLeadCount = 0;

    if (leadStages.length > 0) {
      const leadRows = await tx
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
          ),
        )
        .groupBy(schema.leads.clickIdType);

      for (const row of leadRows) {
        if (row.clickIdType) {
          leadCountsByPlatform.set(
            row.clickIdType,
            (leadCountsByPlatform.get(row.clickIdType) ?? 0) + Number(row.count),
          );
        } else {
          unattributedLeadCount += Number(row.count);
        }
      }
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
      for (const [platform, count] of leadCountsByPlatform) {
        const target = byPlatform.get(platform) ?? byPlatform.set(platform, {}).get(platform)!;
        target[stage.key] = count;
      }
      unattributedStages[stage.key] = unattributedLeadCount;
    }

    const sumAmounts = (ids: Iterable<string>) =>
      [...ids].reduce((sum, id) => sum + (amounts.get(id) ?? 0), 0);

    // Every platform that has either spend or attributed deals in the window.
    const platforms = [
      ...new Set([
        ...spendRows.map((r) => r.platform),
        ...byPlatform.keys(),
        ...leadCountsByPlatform.keys(),
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
