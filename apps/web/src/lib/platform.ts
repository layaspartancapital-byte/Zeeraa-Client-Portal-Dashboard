import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { schema, stageEventsIn } from '@zeeraa/db';
import {
  channelCostPerDeal,
  monthBucketsIn,
  type ChannelCostPerDeal,
  type DateRange,
} from '@zeeraa/core';
import { mergeTypes, type CampaignTypeRow } from '@/lib/platform-types';
import { queryTenant, type TenantSession } from '@/lib/tenant';

/**
 * One ad platform's own reporting, and — kept firmly apart — what the CRM says
 * became of it.
 *
 * The separation is the reason this module exists rather than the numbers
 * being folded into `reporting.ts`. Everything above `outcomes` came out of the
 * platform's API and is true of the platform's own measurement: Google counts a
 * conversion the way Google's tags are configured, Meta counts a lead the way
 * the pixel fires, and neither has any idea whether a deal was funded.
 * `outcomes` comes from Salesforce and answers a different question. Rendering
 * them in one block would invite a reader to divide one by the other.
 *
 * Nothing here computes a figure the platform does not report. Where a platform
 * has no answer the field is `null`, which the page renders as an absence — not
 * as zero, and not by borrowing the other platform's number.
 */

export type PlatformTotals = {
  spend: number;
  impressions: number;
  /** The comparable click: one that goes somewhere. */
  clicks: number;
  conversions: number;
  /**
   * Every click the platform counts, where it distinguishes that from a link
   * click. Null on a platform that reports one figure.
   */
  allClicks: number | null;
  /**
   * Summed daily reach, which is **not** the platform's period reach.
   *
   * Kept out of `PlatformTotals` on purpose — see `reachNote`. This type has no
   * reach field because there is no honest total to put in it.
   */
};

export type CampaignRow = {
  externalCampaignId: string;
  name: string;
  status: string | null;
  campaignType: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  allClicks: number | null;
  reach: number | null;
};

export type DayRow = {
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  allClicks: number | null;
  reach: number | null;
};

export type PlatformOutcomes = {
  /** Null where the tenant configures no value stage. */
  stageLabel: string | null;
  cost: ChannelCostPerDeal;
  /** Funded deals in the window from every source, attributed or not. */
  dealsInPeriod: number;
  /** Of this channel's deals, those whose click also resolves to a campaign. */
  dealsResolvingToCampaign: number;
  /** Per campaign, for the breakdown. Empty where the platform serves no click lookup. */
  byCampaign: { campaignId: string | null; name: string | null; deals: number }[];
  /**
   * Why a per-campaign breakdown is absent, where it is absent by construction
   * rather than by coverage. Null when the platform does resolve campaigns.
   */
  campaignAttributionBlocked: string | null;
};

export type { CampaignTypeRow };

export type PlatformView = {
  platform: string;
  label: string;
  range: DateRange;
  connection: {
    status: string;
    accountIdentifier: string;
    lastSyncAt: Date | null;
    detail: string | null;
  } | null;
  totals: PlatformTotals;
  /** Days on which the platform reported anything at all. */
  daysReported: number;
  byCampaignType: CampaignTypeRow[];
  byCampaign: CampaignRow[];
  daily: DayRow[];
  outcomes: PlatformOutcomes;
};

/**
 * Meta serves no lookup from a click identifier to a campaign, at any grain.
 * This is the reason a Meta page shows no per-campaign outcome table, and it is
 * stated rather than rendered as an empty one — an empty table reads as "no
 * deals yet", which would be wrong and would quietly imply that waiting fixes
 * it.
 */
export const NO_CLICK_LOOKUP: Record<string, string> = {
  meta:
    'Meta publishes no lookup from an fbclid to the campaign that produced it, at any ' +
    'grain. Deals are attributable to Meta as a channel and never to a Meta campaign, ' +
    'so this breakdown is empty by construction rather than for want of data — no ' +
    'amount of further ingestion changes it.',
};

const n = (v: unknown): number => Number(v ?? 0);
const nullableN = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function platformView(
  session: TenantSession,
  platform: string,
  label: string,
  range: DateRange,
  valueStage: { key: string; label: string } | null,
  model: 'first_touch' | 'last_touch',
): Promise<PlatformView> {
  return queryTenant(session, async (tx) => {
    const tenantId = session.tenant.id;
    const inWindow = and(
      eq(schema.dailyMetrics.tenantId, tenantId),
      eq(schema.dailyMetrics.platform, platform),
      gte(schema.dailyMetrics.date, range.start),
      lte(schema.dailyMetrics.date, range.end),
    );

    const [totalsRow] = await tx
      .select({
        spend: sql<string>`coalesce(sum(${schema.dailyMetrics.spend}), 0)`,
        impressions: sql<string>`coalesce(sum(${schema.dailyMetrics.impressions}), 0)`,
        clicks: sql<string>`coalesce(sum(${schema.dailyMetrics.clicks}), 0)`,
        conversions: sql<string>`coalesce(sum(${schema.dailyMetrics.platformConversions}), 0)`,
        // Null when this platform reports no such figure at all, rather than 0:
        // `sum` of all-nulls is null, which is precisely the distinction wanted.
        allClicks: sql<string | null>`sum(${schema.dailyMetrics.clicksAll})`,
        days: sql<number>`count(distinct ${schema.dailyMetrics.date})::int`,
      })
      .from(schema.dailyMetrics)
      .where(inWindow);

    const typeRows = await tx
      .select({
        key: schema.campaigns.campaignType,
        spend: sql<string>`coalesce(sum(${schema.dailyMetrics.spend}), 0)`,
        impressions: sql<string>`coalesce(sum(${schema.dailyMetrics.impressions}), 0)`,
        clicks: sql<string>`coalesce(sum(${schema.dailyMetrics.clicks}), 0)`,
        conversions: sql<string>`coalesce(sum(${schema.dailyMetrics.platformConversions}), 0)`,
        delivering: sql<number>`count(distinct ${schema.dailyMetrics.campaignId})::int`,
      })
      .from(schema.dailyMetrics)
      .leftJoin(schema.campaigns, eq(schema.campaigns.id, schema.dailyMetrics.campaignId))
      .where(inWindow)
      .groupBy(schema.campaigns.campaignType);

    // Every type the account holds, delivering or not. A type that ran nothing
    // is a row of zeroes, which is a measurement; leaving it out is silence.
    const configuredTypes = await tx
      .select({
        key: schema.campaigns.campaignType,
        configured: sql<number>`count(*)::int`,
      })
      .from(schema.campaigns)
      .where(
        and(eq(schema.campaigns.tenantId, tenantId), eq(schema.campaigns.platform, platform)),
      )
      .groupBy(schema.campaigns.campaignType);

    const campaignRows = await tx
      .select({
        externalCampaignId: schema.campaigns.externalCampaignId,
        name: schema.campaigns.name,
        status: schema.campaigns.status,
        campaignType: schema.campaigns.campaignType,
        spend: sql<string>`coalesce(sum(${schema.dailyMetrics.spend}), 0)`,
        impressions: sql<string>`coalesce(sum(${schema.dailyMetrics.impressions}), 0)`,
        clicks: sql<string>`coalesce(sum(${schema.dailyMetrics.clicks}), 0)`,
        conversions: sql<string>`coalesce(sum(${schema.dailyMetrics.platformConversions}), 0)`,
        allClicks: sql<string | null>`sum(${schema.dailyMetrics.clicksAll})`,
        // Deliberately the largest single day rather than a sum. See `reachNote`
        // on the page: reach deduplicates people, so days cannot be added.
        reach: sql<string | null>`max(${schema.dailyMetrics.reach})`,
      })
      .from(schema.dailyMetrics)
      .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.dailyMetrics.campaignId))
      .where(inWindow)
      .groupBy(
        schema.campaigns.externalCampaignId,
        schema.campaigns.name,
        schema.campaigns.status,
        schema.campaigns.campaignType,
      );

    const dayRows = await tx
      .select({
        date: schema.dailyMetrics.date,
        spend: sql<string>`coalesce(sum(${schema.dailyMetrics.spend}), 0)`,
        impressions: sql<string>`coalesce(sum(${schema.dailyMetrics.impressions}), 0)`,
        clicks: sql<string>`coalesce(sum(${schema.dailyMetrics.clicks}), 0)`,
        conversions: sql<string>`coalesce(sum(${schema.dailyMetrics.platformConversions}), 0)`,
        allClicks: sql<string | null>`sum(${schema.dailyMetrics.clicksAll})`,
        // Per day this is a real figure: the platform deduplicated within the
        // day. It is only the total across days that cannot be added.
        reach: sql<string | null>`sum(${schema.dailyMetrics.reach})`,
      })
      .from(schema.dailyMetrics)
      .where(inWindow)
      .groupBy(schema.dailyMetrics.date)
      .orderBy(asc(schema.dailyMetrics.date));

    const [connection] = await tx
      .select({
        status: schema.connections.status,
        accountIdentifier: schema.connections.accountIdentifier,
        lastError: schema.connections.lastError,
        blockedReason: schema.connections.blockedReason,
      })
      .from(schema.connections)
      .where(
        and(eq(schema.connections.tenantId, tenantId), eq(schema.connections.platform, platform)),
      );

    const [lastRun] = await tx
      .select({ finishedAt: schema.syncRuns.finishedAt })
      .from(schema.syncRuns)
      .where(and(eq(schema.syncRuns.tenantId, tenantId), eq(schema.syncRuns.platform, platform)))
      .orderBy(sql`${schema.syncRuns.startedAt} desc`)
      .limit(1);

    const outcomes = await platformOutcomes(tx, tenantId, platform, range, valueStage, model);

    return {
      platform,
      label,
      range,
      connection: connection
        ? {
            status: connection.status,
            accountIdentifier: connection.accountIdentifier,
            lastSyncAt: lastRun?.finishedAt ?? null,
            detail: connection.blockedReason ?? connection.lastError ?? null,
          }
        : null,
      totals: {
        spend: n(totalsRow?.spend),
        impressions: n(totalsRow?.impressions),
        clicks: n(totalsRow?.clicks),
        conversions: n(totalsRow?.conversions),
        allClicks: nullableN(totalsRow?.allClicks),
      },
      daysReported: Number(totalsRow?.days ?? 0),
      byCampaignType: mergeTypes(typeRows, configuredTypes),
      byCampaign: campaignRows
        .map((r) => ({
          externalCampaignId: r.externalCampaignId,
          name: r.name,
          status: r.status,
          campaignType: r.campaignType,
          spend: n(r.spend),
          impressions: n(r.impressions),
          clicks: n(r.clicks),
          conversions: n(r.conversions),
          allClicks: nullableN(r.allClicks),
          reach: nullableN(r.reach),
        }))
        .sort((a, b) => b.spend - a.spend),
      daily: dayRows.map((r) => ({
        date: r.date,
        spend: n(r.spend),
        impressions: n(r.impressions),
        clicks: n(r.clicks),
        conversions: n(r.conversions),
        allClicks: nullableN(r.allClicks),
        reach: nullableN(r.reach),
      })),
      outcomes,
    };
  });
}

/**
 * What the CRM says became of this channel's spend.
 *
 * The same arithmetic the executive hero and the monthly table use, scoped to
 * one platform: both halves of the figure come from this channel, and deals no
 * channel can claim are counted separately and never enter the denominator.
 */
async function platformOutcomes(
  tx: Parameters<Parameters<typeof queryTenant>[1]>[0],
  tenantId: string,
  platform: string,
  range: DateRange,
  valueStage: { key: string; label: string } | null,
  model: 'first_touch' | 'last_touch',
): Promise<PlatformOutcomes> {
  const blocked = NO_CLICK_LOOKUP[platform] ?? null;

  if (!valueStage) {
    return {
      stageLabel: null,
      cost: channelCostPerDeal({ channelSpend: 0, attributedDeals: 0, unattributedDeals: 0 }),
      dealsInPeriod: 0,
      dealsResolvingToCampaign: 0,
      byCampaign: [],
      campaignAttributionBlocked: blocked,
    };
  }

  const [spendRow] = await tx
    .select({ spend: sql<string>`coalesce(sum(${schema.dailyMetrics.spend}), 0)` })
    .from(schema.dailyMetrics)
    .where(
      and(
        eq(schema.dailyMetrics.tenantId, tenantId),
        eq(schema.dailyMetrics.platform, platform),
        gte(schema.dailyMetrics.date, range.start),
        lte(schema.dailyMetrics.date, range.end),
      ),
    );

  const funded = await tx
    .select({
      opportunityExternalId: schema.stageEvents.opportunityExternalId,
      attributedPlatform: schema.attribution.platform,
      campaignId: schema.attribution.campaignId,
      campaignName: schema.campaigns.name,
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
    .leftJoin(schema.campaigns, eq(schema.campaigns.id, schema.attribution.campaignId))
    .where(
      and(
        eq(schema.stageEvents.tenantId, tenantId),
        eq(schema.stageEvents.stage, valueStage.key),
        stageEventsIn(range),
      ),
    );

  // A stage can recur, so one opportunity can hold two events for it. Counting
  // rows would count the deal twice.
  const all = new Set<string>();
  const here = new Set<string>();
  const elsewhere = new Set<string>();
  const resolving = new Set<string>();
  const byCampaign = new Map<string, { campaignId: string | null; name: string | null; deals: Set<string> }>();

  for (const row of funded) {
    all.add(row.opportunityExternalId);
    if (row.attributedPlatform === platform) {
      here.add(row.opportunityExternalId);
      if (row.campaignId) {
        resolving.add(row.opportunityExternalId);
        const entry = byCampaign.get(row.campaignId) ?? {
          campaignId: row.campaignId,
          name: row.campaignName,
          deals: new Set<string>(),
        };
        entry.deals.add(row.opportunityExternalId);
        byCampaign.set(row.campaignId, entry);
      }
    } else if (row.attributedPlatform) {
      elsewhere.add(row.opportunityExternalId);
    }
  }
  // A deal this channel can claim under one touch is this channel's even if
  // another row named somebody else.
  for (const id of here) elsewhere.delete(id);
  const unattributed = [...all].filter((id) => !here.has(id) && !elsewhere.has(id)).length;

  return {
    stageLabel: valueStage.label,
    cost: channelCostPerDeal({
      channelSpend: n(spendRow?.spend),
      attributedDeals: here.size,
      unattributedDeals: unattributed,
      dealsAttributedElsewhere: elsewhere.size,
    }),
    dealsInPeriod: all.size,
    dealsResolvingToCampaign: resolving.size,
    byCampaign: [...byCampaign.values()]
      .map((e) => ({ campaignId: e.campaignId, name: e.name, deals: e.deals.size }))
      .sort((a, b) => b.deals - a.deals),
    campaignAttributionBlocked: blocked,
  };
}

/** Month buckets over the window, for the time series. */
export function seriesBuckets(range: DateRange) {
  return monthBucketsIn(range);
}
