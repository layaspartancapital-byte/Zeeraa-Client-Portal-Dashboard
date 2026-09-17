import { and, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { schema, type Database } from '@zeeraa/db';
import {
  attributionCoverage,
  channelCostPerDeal,
  resolveBothModels,
  type AttributionCoverage,
  type AttributionModel,
  type AttributionTouch,
  type ChannelCostPerDeal,
  type DateRange,
} from '@zeeraa/core';
import { clicksByClickId } from './writer';

/**
 * The spend-to-funded join.
 *
 * Two halves meet here, and only one of them is durable. The CRM half — a
 * `gclid` on a lead, carried to the opportunity it became — Salesforce keeps
 * indefinitely. The ads half — which campaign that click belonged to and what
 * it cost — Google serves for ninety days and then stops. So this join is not
 * a query that can be written later against data that will still be there; the
 * `ad_clicks` rows it reads have to be captured while they exist.
 *
 * What it does not do is invent coverage. An opportunity with no click is
 * reported as unattributed rather than distributed across campaigns, and the
 * unattributed share travels with every figure that comes out of here.
 */

export type JoinResult = {
  opportunities: number;
  attributionRows: number;
  coverage: Record<AttributionModel, AttributionCoverage>;
};

/**
 * Gathers every observed click touch per opportunity.
 *
 * Two routes, deliberately unioned rather than preferred:
 *
 *   - `opportunity_click_ids`, which holds both the mapped-field route and the
 *     converted-Lead backfill, each tagged with how it was learned.
 *   - `leads.click_id` joined through `leads.converted_opportunity_id`, which
 *     covers a lead whose click never made it into the click-id table.
 *
 * Deduplicated on (opportunity, click id) so the same click learned two ways
 * counts once. Where the two routes disagree about a value, both are kept as
 * separate touches — that disagreement is a real signal that the field mapping
 * has a gap, and collapsing it would hide the thing worth knowing.
 */
export async function gatherTouches(
  tx: Database,
  tenantId: string,
): Promise<Map<string, AttributionTouch[]>> {
  const fromClickIds = await tx
    .select({
      opportunityExternalId: schema.opportunityClickIds.opportunityExternalId,
      platform: schema.opportunityClickIds.platform,
      clickId: schema.opportunityClickIds.clickId,
    })
    .from(schema.opportunityClickIds)
    .where(eq(schema.opportunityClickIds.tenantId, tenantId));

  const fromLeads = await tx
    .select({
      opportunityExternalId: schema.leads.convertedOpportunityId,
      platform: schema.leads.clickIdType,
      clickId: schema.leads.clickId,
    })
    .from(schema.leads)
    .where(
      and(
        eq(schema.leads.tenantId, tenantId),
        isNotNull(schema.leads.convertedOpportunityId),
        isNotNull(schema.leads.clickId),
      ),
    );

  const pairs = [
    ...fromClickIds.map((r) => ({
      opportunityExternalId: r.opportunityExternalId,
      platform: r.platform,
      clickId: r.clickId,
    })),
    ...fromLeads.map((r) => ({
      opportunityExternalId: r.opportunityExternalId!,
      platform: r.platform ?? 'unknown',
      clickId: r.clickId!,
    })),
  ];

  const clicks = await clicksByClickId(tx, tenantId, [...new Set(pairs.map((p) => p.clickId))]);

  const byOpportunity = new Map<string, AttributionTouch[]>();
  const seen = new Set<string>();

  for (const pair of pairs) {
    const key = `${pair.opportunityExternalId}|${pair.clickId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const click = clicks.get(pair.clickId);
    const touches = byOpportunity.get(pair.opportunityExternalId) ?? [];
    touches.push({
      clickId: pair.clickId,
      platform: click?.platform ?? pair.platform,
      // Null when the click is known to the CRM but has no ad_clicks row —
      // almost always because it aged out of the 90-day window. The touch is
      // kept so the deal reports as "click without campaign" rather than as
      // "no paid click", which are different facts about the same deal.
      campaignId: click?.campaignId ?? null,
      // An unmatched click has no reported date. The empty string sorts before
      // every real date, which puts an unresolvable touch first under
      // first-touch and last under last-touch — the conservative placement
      // either way, since it can never displace a click we can actually cost.
      occurredOn: click?.reportedDate ?? '',
    });
    byOpportunity.set(pair.opportunityExternalId, touches);
  }

  return byOpportunity;
}

/**
 * Resolves both models for every opportunity and writes `attribution`.
 *
 * Both models are stored from day one (§4): backfilling a second model later is
 * impossible once click history has aged out, which for Google is ninety days.
 */
export async function buildAttribution(
  tx: Database,
  tenantId: string,
): Promise<JoinResult> {
  const touchesByOpportunity = await gatherTouches(tx, tenantId);

  const rows: {
    tenantId: string;
    opportunityExternalId: string;
    model: AttributionModel;
    platform: string | null;
    campaignId: string | null;
    clickId: string | null;
  }[] = [];
  const choices: Record<AttributionModel, ReturnType<typeof resolveBothModels>[AttributionModel][]> =
    { first_touch: [], last_touch: [] };

  for (const [opportunityExternalId, touches] of touchesByOpportunity) {
    const resolved = resolveBothModels(touches);
    for (const model of ['first_touch', 'last_touch'] as const) {
      const choice = resolved[model];
      choices[model].push(choice);
      rows.push({
        tenantId,
        opportunityExternalId,
        model,
        platform: choice.touch?.platform ?? null,
        campaignId: choice.touch?.campaignId ?? null,
        clickId: choice.touch?.clickId ?? null,
      });
    }
  }

  if (rows.length > 0) {
    await tx
      .insert(schema.attribution)
      .values(rows.map((r) => ({ ...r, updatedAt: new Date() })))
      .onConflictDoUpdate({
        target: [
          schema.attribution.tenantId,
          schema.attribution.opportunityExternalId,
          schema.attribution.model,
        ],
        set: {
          platform: sql`excluded.platform`,
          campaignId: sql`excluded.campaign_id`,
          clickId: sql`excluded.click_id`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  return {
    opportunities: touchesByOpportunity.size,
    attributionRows: rows.length,
    coverage: {
      first_touch: attributionCoverage(choices.first_touch),
      last_touch: attributionCoverage(choices.last_touch),
    },
  };
}

/**
 * Which funnel stage counts as funded, from configuration.
 *
 * Read from `funnel_stages.counts_value` rather than assumed to be called
 * "funded": a tenant running Lead → Demo → Trial → Subscription has a different
 * word for it and the same engine has to work (§4).
 */
export async function valueStageKey(tx: Database, tenantId: string): Promise<string | null> {
  const [row] = await tx
    .select({ key: schema.funnelStages.key })
    .from(schema.funnelStages)
    .where(
      and(eq(schema.funnelStages.tenantId, tenantId), eq(schema.funnelStages.countsValue, true)),
    )
    .limit(1);
  return row?.key ?? null;
}

export type SpendToFunded = ChannelCostPerDeal & {
  platform: string;
  /** Which stage counts as value for this tenant. Null when none is configured. */
  stage: string | null;
  model: AttributionModel;
  range: DateRange;
  /** Deals reaching the value stage in the period, from every source. Context, never a denominator. */
  dealsInPeriod: number;
  /**
   * Of `attributedDeals`, those whose click also resolves to a campaign.
   *
   * The remainder are deals we know came from this channel — a `gclid` is a
   * Google Ads click by definition — whose click has aged out of the platform's
   * lookback window. They belong in the channel's denominator, because the
   * channel is known; they cannot appear in the per-campaign breakdown, because
   * the campaign is not.
   */
  dealsResolvingToCampaign: number;
  /** Per campaign, for the breakdown. Campaigns with no funded deal included. */
  byCampaign: {
    campaignId: string | null;
    campaignName: string | null;
    spend: number;
    fundedDeals: number;
    costPerFundedDeal: number | null;
  }[];
};

/**
 * Spend in the period against deals that reached the value stage in the period.
 *
 * Both sides are period-bounded on their own event, not on each other. A deal
 * funded in October from a click bought in August belongs in October's funded
 * count and August's spend — that is what a cost per funded deal in a period
 * means, and pairing each deal with its own click's spend instead would be a
 * cohort metric wearing a period metric's name.
 */
export async function spendToFunded(
  tx: Database,
  tenantId: string,
  platform: string,
  range: DateRange,
  model: AttributionModel,
): Promise<SpendToFunded> {
  const stage = await valueStageKey(tx, tenantId);

  const spendRows = await tx
    .select({
      campaignId: schema.dailyMetrics.campaignId,
      campaignName: schema.campaigns.name,
      spend: sql<string>`sum(${schema.dailyMetrics.spend})`,
    })
    .from(schema.dailyMetrics)
    .leftJoin(schema.campaigns, eq(schema.campaigns.id, schema.dailyMetrics.campaignId))
    .where(
      and(
        eq(schema.dailyMetrics.tenantId, tenantId),
        eq(schema.dailyMetrics.platform, platform),
        gte(schema.dailyMetrics.date, range.start),
        lte(schema.dailyMetrics.date, range.end),
      ),
    )
    .groupBy(schema.dailyMetrics.campaignId, schema.campaigns.name);

  const funded = stage
    ? await tx
        .select({
          campaignId: schema.attribution.campaignId,
          attributedPlatform: schema.attribution.platform,
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
            eq(schema.stageEvents.stage, stage),
            gte(schema.stageEvents.occurredAt, new Date(`${range.start}T00:00:00Z`)),
            lte(schema.stageEvents.occurredAt, new Date(`${range.end}T23:59:59.999Z`)),
          ),
        )
    : [];

  // A stage can recur, so the same opportunity can hold two events for it.
  // Counting rows would count the deal twice.
  const dealsByCampaign = new Map<string | null, Set<string>>();
  const dealsInPeriod = new Set<string>();
  const attributedHere = new Set<string>();
  const resolvingToCampaign = new Set<string>();
  const attributedElsewhere = new Set<string>();

  for (const row of funded) {
    dealsInPeriod.add(row.opportunityExternalId);

    if (row.attributedPlatform === platform) {
      attributedHere.add(row.opportunityExternalId);
      if (row.campaignId != null) {
        resolvingToCampaign.add(row.opportunityExternalId);
        const set = dealsByCampaign.get(row.campaignId) ?? new Set<string>();
        set.add(row.opportunityExternalId);
        dealsByCampaign.set(row.campaignId, set);
      }
    } else if (row.attributedPlatform != null) {
      attributedElsewhere.add(row.opportunityExternalId);
    }
  }

  // A deal attributed to this channel under one touch is this channel's, even
  // if another row for the same deal named somebody else. The sets are built in
  // that order so the stronger claim wins rather than the last row read.
  for (const id of attributedHere) attributedElsewhere.delete(id);
  const unattributedDeals = [...dealsInPeriod].filter(
    (id) => !attributedHere.has(id) && !attributedElsewhere.has(id),
  ).length;

  const byCampaign = spendRows.map((row) => {
    const deals = dealsByCampaign.get(row.campaignId)?.size ?? 0;
    const spend = Number(row.spend ?? 0);
    return {
      campaignId: row.campaignId,
      campaignName: row.campaignName ?? null,
      spend,
      fundedDeals: deals,
      // The same rule one level down: a campaign's spend over the deals
      // attributed to that campaign, never over the channel's deals.
      costPerFundedDeal: deals === 0 ? null : spend / deals,
    };
  });

  // Every unit of this channel's spend in the period, including spend that
  // resolved to no campaign. Account-level spend is still this channel's spend,
  // and excluding it would understate what the channel cost.
  const channelSpend = byCampaign.reduce((sum, c) => sum + c.spend, 0);

  return {
    platform,
    stage,
    model,
    range,
    dealsInPeriod: dealsInPeriod.size,
    dealsResolvingToCampaign: resolvingToCampaign.size,
    ...channelCostPerDeal({
      channelSpend,
      attributedDeals: attributedHere.size,
      unattributedDeals,
      dealsAttributedElsewhere: attributedElsewhere.size,
    }),
    byCampaign,
  };
}
