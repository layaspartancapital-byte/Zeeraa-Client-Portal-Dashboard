import { and, asc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { platformLabel } from '@/lib/platform-labels';
import {
  callsIn,
  countedStageEvent,
  leadChannel,
  leadsCreatedIn,
  schema,
  stageEventsIn,
  submissionsIn,
  type Database,
} from '@zeeraa/db';
import {
  attemptsPerLead,
  callVolume,
  channelCostPerDeal,
  clockLabel,
  isPaidChannel,
  sourceRank,
  parseBusinessHours,
  parseLeadSourceRules,
  previousMonth,
  rankReasonCitations,
  reasonCoverageByPeriod,
  responseSeconds,
  speedToLead,
  stageBeforeValue,
  stageCohorts,
  submissionOfferRate,
  pendingState,
  EMPTY_PENDING,
  type PendingTally,
  type AttributionModel,
  type BusinessHours,
  type ChannelCostPerDeal,
  type DateRange,
  type ReasonCitations,
  type ReasonCoverage,
  type AttemptsPerLead,
  type CallVolume,
  type SpeedToLead,
  type StageCohorts,
  type StageDefinition,
  type SubmissionOfferRate,
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

export { PLATFORM_LABELS, platformLabel } from '@/lib/platform-labels';

/**
 * The offered amount on the deals reaching the stage before value (Offer),
 * each deal counted once at its highest offer (`opportunities.max_offer_amount`).
 * `deals` is how many of those deals carry an amount at all: a deal approved
 * before its first offer is recorded has none, and is not a $0 offer.
 */
export type OfferedAmount = { amount: number; deals: number };

/** Every population at once, for a total. */
const ANY = Symbol('any');

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
  /**
   * Whether the channel buys its traffic. Organic search does not: it has no
   * spend, CTR, CPC or cost per deal, and those cells render an em dash with
   * `noSpendReason` (core), never $0 (`isPaidChannel` in core). A lead vendor
   * is paid, but outside the ad platforms, and its spend is not ingested.
   */
  paid: boolean;
  spend: number;
  impressions: number;
  clicks: number;
  /** Null rather than zero when there were no impressions to divide by. */
  ctr: number | null;
  cpc: number | null;
  /** Opportunities attributed to this channel, by stage. */
  stages: StageCounts;
  /** Where this channel's records at each stage have got to since. */
  cohorts: StageCohorts;
  /** Funded amount on deals attributed to this channel. */
  valueVolume: number;
  offered: OfferedAmount;
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
  cohorts: StageCohorts;
  valueVolume: number;
  offered: OfferedAmount;
  /** Why these cannot be costed, in the interface's voice. */
  reason: string;
};

/**
 * The totals line.
 *
 * Sums only what is summable. Spend adds across channels; deals add across every
 * source, attributed or not, because that is the business's real total. Cost per
 * deal does not add, and is not one total divided by the other either — that is
 * cost per funded deal across all sources, a different metric with its own denominator
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
  cohorts: StageCohorts;
  valueVolume: number;
  offered: OfferedAmount;
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
  /**
   * Whether this tenant can credit anything to SEO/Organic at all — it has a
   * readable `lead_source_rules` row. Without one, an SEO/Organic row of zero
   * would claim a measurement nobody made.
   */
  organicMeasured: boolean;
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
  declines: {
    deals: number;
    events: number;
    /**
     * `deals` split by the month of each deal's first decline *inside the
     * window*, so every deal is in exactly one month and the months sum to
     * `deals`. Only months the window touches; a month with none is absent.
     */
    byMonth: { month: string; deals: number }[];
  };
  /**
   * What the stage order asserts, checked against the records.
   *
   * The funnel draws stages left to right and puts a conversion rate on each
   * connector, which asserts two things the data has to be asked about rather
   * than assumed: that the later population is drawn from the earlier one, and
   * that a deal which reaches a stage stays reached. Neither holds here — 10 of
   * 67 deals with an offer have no approval event at all, and 46 of those 67
   * were declined after their last offer.
   *
   * So each entry is measured, per stage key:
   *
   *   * `reached` — deals reaching this stage in the window;
   *   * `alsoPrevious` — how many of those also reached the stage before it,
   *     which is the nesting the rate above it depends on;
   *   * `laterLost` — how many went on to a decline *after* reaching it, which
   *     is the regression a left-to-right funnel cannot draw.
   */
  progression: Record<
    string,
    { reached: number; previous: string | null; alsoPrevious: number; laterLost: number }
  >;
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

const ALL_SOURCES_ELSEWHERE =
  'A total row would put every channel’s spend over every source’s deals, which ' +
  'is not a channel figure. That figure is on Executive’s Zeeraa contract ' +
  'targets card, against the contract.';

const UNATTRIBUTED_REASON =
  'No ad click, no lead vendor and no website or search referrer: direct visits, ' +
  'referrals, phone and repeat business, and possibly paid media that was never ' +
  'tagged. Nothing in the data says which, so no channel may count them and no ' +
  'spend stands behind them.';

/**
 * Every deal each stage has ever reached, counting only events that count
 * (`countedStageEvent()`): stage key to opportunity external ids.
 *
 * Whether a deal reached a stage is a fact about the deal, not about any
 * window, so this is the same for every range — which is why it is read once
 * per data version (`cached-reports.ts`) and handed to each
 * `monthlyPerformance` call rather than read again by every one. One row per
 * stage, the ids joined by a unit separator: a row per (stage, deal) pair cost
 * three times the bytes on the wire for the same set (30 October 2026).
 */
export type StageMembership = Record<string, string[]>;

const ID_SEPARATOR = '\u001f';

export async function stageMembership(session: TenantSession): Promise<StageMembership> {
  return queryTenant(session, (tx) => readStageMembership(tx, session.tenant.id));
}

async function readStageMembership(tx: Database, tenantId: string): Promise<StageMembership> {
  const rows = await tx
    .select({
      stage: schema.stageEvents.stage,
      ids: sql<string>`string_agg(distinct ${schema.stageEvents.opportunityExternalId}, chr(31))`,
    })
    .from(schema.stageEvents)
    // An excluded event did not happen, as far as progression is concerned:
    // a renewal's Funded must not make its approval look converted.
    .where(and(eq(schema.stageEvents.tenantId, tenantId), countedStageEvent()))
    .groupBy(schema.stageEvents.stage);
  return Object.fromEntries(rows.map((r) => [r.stage, r.ids ? r.ids.split(ID_SEPARATOR) : []]));
}

/** `values` as a typed Postgres array literal of parameters. */
function textArray(values: readonly (string | null)[]) {
  return sql`array[${sql.join(
    values.map((v) => sql`${v}::text`),
    sql`, `,
  )}]::text[]`;
}

export async function monthlyPerformance(
  session: TenantSession,
  range: DateRange,
  model: AttributionModel = 'last_touch',
  /** From `performanceContext`, when the caller already has it for this data version. */
  context?: PerformanceContext,
): Promise<MonthlyPerformance> {
  const [report] = await monthlyPerformances(session, [range], model, context);
  return report!;
}

/**
 * Several ranges at once (30 October 2026): every figure of every range in
 * one statement, so two periods cost one round trip, not two dozen.
 *
 * Unprepared, the driver describes each parameterised query before it can
 * bind it, one query at a time on a connection; a report of seventeen reads
 * waited for thirty-four round trips in a row, and Comparison's two periods
 * for twice that. Here each range's reads are subqueries of one statement,
 * returned as JSON in the shapes the separate reads had, and assembled
 * below exactly as before. What does not depend on the range is
 * `performanceContext`, read once per data version.
 */
export async function monthlyPerformances(
  session: TenantSession,
  ranges: readonly DateRange[],
  model: AttributionModel = 'last_touch',
  context?: PerformanceContext,
): Promise<MonthlyPerformance[]> {
  return queryTenant(session, async (tx) => {
    const ctx = context ?? (await readPerformanceContext(tx, session.tenant.id));
    const periods = await readPeriods(tx, session.tenant.id, ranges, model, ctx);
    return ranges.map((range, i) => assembleMonthlyPerformance(session, range, model, ctx, periods[i]!));
  });
}

/**
 * What every range's report reads that no range changes: the funnel, its
 * blocked and computed stages, which deals ever reached each stage, the
 * windowed sources, the lead-source rule and the last sync. The same until
 * the data version moves, so cached per data version (`cached-reports.ts`).
 */
export type PerformanceContext = Awaited<ReturnType<typeof readPerformanceContext>>;

export async function performanceContext(session: TenantSession): Promise<PerformanceContext> {
  return queryTenant(session, (tx) => readPerformanceContext(tx, session.tenant.id));
}

async function readPerformanceContext(tx: Database, tenantId: string) {
  const [stages, blockedRows, originRows, membership, windowRows, [organicRule], [latestSync]] = await Promise.all([
    tx.select().from(schema.funnelStages).where(eq(schema.funnelStages.tenantId, tenantId)).orderBy(asc(schema.funnelStages.position)),
    tx
      .select()
      .from(schema.blockedDependencies)
      .where(and(eq(schema.blockedDependencies.tenantId, tenantId), eq(schema.blockedDependencies.subjectKind, 'funnel_stage'))),
    // How each stage's timestamps were established. A stage whose events are
    // computed is marked as computed everywhere it renders.
    tx
      .select({ stage: schema.stageEvents.stage, origin: schema.stageEvents.origin })
      .from(schema.stageEvents)
      .where(eq(schema.stageEvents.tenantId, tenantId))
      .groupBy(schema.stageEvents.stage, schema.stageEvents.origin),
    /*
     * Stage membership, for the progression check. Unbounded by window on
     * purpose: whether a deal reached the previous stage is a fact about the
     * deal rather than about the window — a deal approved in May and offered
     * in July did reach approval, and a 90-day window that excludes May must
     * not report otherwise.
     */
    readStageMembership(tx, tenantId),
    // The window each windowed source can speak for, keyed as `window:*` by
    // `recordSourceWindow`.
    tx
      .select({ factKey: schema.dataSources.factKey, asOf: schema.dataSources.asOf })
      .from(schema.dataSources)
      .where(eq(schema.dataSources.tenantId, tenantId)),
    tx
      .select({ value: schema.tenantConfig.value })
      .from(schema.tenantConfig)
      .where(and(eq(schema.tenantConfig.tenantId, tenantId), eq(schema.tenantConfig.key, 'lead_source_rules')))
      .limit(1),
    tx
      .select({ finishedAt: schema.syncRuns.finishedAt })
      .from(schema.syncRuns)
      .where(and(eq(schema.syncRuns.tenantId, tenantId), eq(schema.syncRuns.status, 'succeeded')))
      .orderBy(sql`${schema.syncRuns.finishedAt} desc nulls last`)
      .limit(1),
  ]);
  return { stages, blockedRows, originRows, membership, windowRows, organicRule, latestSync };
}

/** One range's reads, in the shapes the separate queries returned. */
type PeriodReads = {
  /** Leads created in the range by channel, verdict and the opportunity each became. */
  cohort: { channel: string | null; qualified: boolean; opportunity: string | null; count: number }[];
  spend: { platform: string; spend: string; impressions: string; clicks: string }[];
  /** One row per (stage, platform), the deals joined by a unit separator. */
  stageGroups: { stage: string; platform: string | null; ids: string }[];
  verdicts: { verdict: string | null; count: number }[];
  decline: { deals: number; events: number };
  declineMonths: { month: string; deals: number }[];
  topReason: { reason: string | null; count: number } | null;
  progression: { stage: string; reached: number; also_previous: number; later_lost: number }[];
  amounts: { externalId: string; fundedAmount: string | null; amount: string | null }[];
  offers: { externalId: string; maxOfferAmount: string | null }[];
};

/** Every range's reads, as one statement returning one JSON object per range. */
async function readPeriods(
  tx: Database,
  tenantId: string,
  ranges: readonly DateRange[],
  model: AttributionModel,
  ctx: PerformanceContext,
): Promise<PeriodReads[]> {
  const L = schema.leads;
  const SE = schema.stageEvents;
  const A = schema.attribution;
  const O = schema.opportunities;
  const DM = schema.dailyMetrics;
  const rows = (q: SQL, order: SQL = sql``) => sql`(select coalesce(json_agg(x ${order}), '[]'::json) from (${q}) x)`;

  const valueStage = ctx.stages.find((s) => s.countsValue)?.key ?? null;
  const offeredStage = stageBeforeValue(ctx.stages)?.key ?? null;
  const eventStages = ctx.stages.filter((st) => (st.source ?? 'stage_events') === 'stage_events');
  const keys = eventStages.map((st) => st.key);
  const previousKeys = eventStages.map((_, i) => (i === 0 ? null : (eventStages[i - 1]?.key ?? null)));
  // The deals reaching a stage in the range, as the stage rows count them.
  const dealsAt = (stage: string, range: DateRange) =>
    sql`select distinct ${SE.opportunityExternalId} from ${SE} where ${and(eq(SE.tenantId, tenantId), eq(SE.stage, stage), stageEventsIn(range))}`;

  const period = (range: DateRange) => sql`json_build_object(
    'cohort', ${rows(sql`
      select ${leadChannel()} as channel, ${L.mqlVerdict} is not distinct from 'qualified' as qualified,
             ${L.convertedOpportunityId} as opportunity, count(*)::int as count
      from ${L} where ${and(eq(L.tenantId, tenantId), leadsCreatedIn(range))}
      group by 1, 2, 3`)},
    'spend', ${rows(sql`
      select ${DM.platform} as platform, coalesce(sum(${DM.spend}), 0)::text as spend,
             coalesce(sum(${DM.impressions}), 0)::text as impressions, coalesce(sum(${DM.clicks}), 0)::text as clicks
      from ${DM} where ${and(eq(DM.tenantId, tenantId), gte(DM.date, range.start), lte(DM.date, range.end))}
      group by 1`)},
    'stageGroups', ${rows(sql`
      select ${SE.stage} as stage, ${A.platform} as platform,
             string_agg(distinct ${SE.opportunityExternalId}, chr(31)) as ids
      from ${SE}
      left join ${A} on ${and(eq(A.tenantId, SE.tenantId), eq(A.opportunityExternalId, SE.opportunityExternalId), eq(A.model, model))}
      where ${and(eq(SE.tenantId, tenantId), stageEventsIn(range))}
      group by 1, 2`)},
    'verdicts', ${rows(sql`
      select ${L.mqlVerdict} as verdict, count(*)::int as count
      from ${L} where ${and(eq(L.tenantId, tenantId), leadsCreatedIn(range))}
      group by 1`)},
    'decline', (
      select json_build_object('deals', count(distinct ${SE.opportunityExternalId})::int, 'events', count(*)::int)
      from ${SE} where ${and(eq(SE.tenantId, tenantId), eq(SE.stage, 'declined'), stageEventsIn(range))}),
    -- The same deals, each placed once: in the month of its first decline in
    -- the window. A deal declined in June and again in August is one deal, and
    -- one bar, rather than a bar in each — which is how the bars came to sum
    -- to 574 under a headline of 394 (24 September 2026).
    'declineMonths', ${rows(
      sql`
      select to_char(first_on, 'YYYY-MM') as month, count(*)::int as deals
      from (
        select ${SE.opportunityExternalId}, min(${SE.occurredOn}) as first_on
        from ${SE} where ${and(eq(SE.tenantId, tenantId), eq(SE.stage, 'declined'), stageEventsIn(range))}
        group by 1
      ) firsts
      group by 1`,
      sql`order by x.month`,
    )},
    'topReason', (
      select row_to_json(x) from (
        select ${L.mqlUndeterminableReason} as reason, count(*)::int as count
        from ${L} where ${and(eq(L.tenantId, tenantId), eq(L.mqlVerdict, 'undeterminable'), leadsCreatedIn(range))}
        group by 1 order by count(*) desc limit 1
      ) x),
    'progression', ${
      eventStages.length === 0
        ? sql`'[]'::json`
        : rows(sql`
      with p as (
        select * from unnest(${textArray(keys)}, ${textArray(previousKeys)}) as p(stage, prev)
      ),
      r as (
        select ${SE.stage} as stage, ${SE.opportunityExternalId} as id, max(${SE.occurredAt}) as at
        from ${SE}
        where ${and(eq(SE.tenantId, tenantId), stageEventsIn(range))}
        group by 1, 2
      ),
      m as (
        select distinct ${SE.stage} as stage, ${SE.opportunityExternalId} as id
        from ${SE}
        where ${and(eq(SE.tenantId, tenantId), countedStageEvent())}
      ),
      d as (
        select ${SE.opportunityExternalId} as id, max(${SE.occurredAt}) as at
        from ${SE}
        where ${and(eq(SE.tenantId, tenantId), eq(SE.stage, 'declined'))}
        group by 1
      )
      select
        p.stage,
        count(r.id)::int as reached,
        (case
          when p.prev is null or not exists (select 1 from m where m.stage = p.prev) then count(r.id)
          else count(r.id) filter (where exists (select 1 from m where m.stage = p.prev and m.id = r.id))
        end)::int as also_previous,
        (case
          when p.stage = 'declined' then 0
          else count(r.id) filter (where exists (
            select 1 from d
            where d.id = r.id and date_trunc('milliseconds', d.at) > date_trunc('milliseconds', r.at)
          ))
        end)::int as later_lost
      from p
      left join r on r.stage = p.stage
      group by p.stage, p.prev`)
    },
    'amounts', ${
      valueStage
        ? rows(sql`
      select ${O.externalId} as "externalId", ${O.fundedAmount}::text as "fundedAmount", ${O.amount}::text as "amount"
      from ${O}
      where ${eq(O.tenantId, tenantId)} and ${O.externalId} in (${dealsAt(valueStage, range)})`)
        : sql`'[]'::json`
    },
    'offers', ${
      offeredStage
        ? rows(sql`
      select ${O.externalId} as "externalId", ${O.maxOfferAmount}::text as "maxOfferAmount"
      from ${O}
      where ${eq(O.tenantId, tenantId)} and ${O.externalId} in (${dealsAt(offeredStage, range)})`)
        : sql`'[]'::json`
    }
  )`;

  const [row] = await tx.execute<{ periods: PeriodReads[] }>(
    sql`select json_build_array(${sql.join(ranges.map(period), sql`, `)}) as periods`,
  );
  return row!.periods;
}

/** One range's report from its reads: the arithmetic every screen shares. */
function assembleMonthlyPerformance(
  session: TenantSession,
  range: DateRange,
  model: AttributionModel,
  ctx: PerformanceContext,
  period: PeriodReads,
): MonthlyPerformance {
  const { stages, blockedRows, originRows, windowRows, organicRule, latestSync } = ctx;
  const cohortLeadGroups = period.cohort;
  const spendRows = period.spend;
  const verdictRows = period.verdicts;
  const declineRow = period.decline;
  const declineMonths = period.declineMonths;
  const topReasonRow = period.topReason ?? undefined;

  const valueStage = stages.find((s) => s.countsValue)?.key ?? null;
  const blockedByStage = new Map(blockedRows.map((b) => [b.subjectKey, b]));
  const computedStages = new Set(originRows.filter((r) => r.origin === 'computed').map((r) => r.stage));

  /**
   * Stages measured at lead grain, counted from `leads` rather than from
   * stage events.
   *
   * A lead that never became an opportunity has no opportunity to attribute
   * through, so the channel comes from the lead itself (`leadChannel()`). The
   * population is already inbound — cold outreach is excluded at ingest — so
   * nothing here re-filters it.
   *
   * `qualified_leads` is the same population narrowed to leads that pass the
   * bar. It is a separate source rather than a filter applied later because
   * the grain is the point: a qualified lead is a property of a *lead*, and
   * counting it from `stage_events` would count only the ones that went on to
   * become opportunities — a different, much smaller number wearing the name
   * MQL, and the numerator of a rate whose denominator is every lead.
   */
  const leadStages = stages.filter((s) => s.source === 'leads' || s.source === 'qualified_leads');
  /** Per lead-grain stage: attributed counts by platform, and the rest. */
  const leadCounts = new Map<string, { byPlatform: Map<string, number>; unattributed: number }>();
  for (const stage of leadStages) {
    const byPlatformCounts = new Map<string, number>();
    let unattributed = 0;
    for (const g of cohortLeadGroups) {
      if (stage.source === 'qualified_leads' && !g.qualified) continue;
      if (g.channel) byPlatformCounts.set(g.channel, (byPlatformCounts.get(g.channel) ?? 0) + Number(g.count));
      else unattributed += Number(g.count);
    }
    leadCounts.set(stage.key, { byPlatform: byPlatformCounts, unattributed });
  }

  // A lead is only ever a member of a set here, so any key unique within
  // this call will do; the prefix keeps it apart from opportunity ids.
  let leadKey = 0;
  const cohortLeads = (leadStages.length === 0 ? [] : cohortLeadGroups).flatMap((g) =>
    Array.from({ length: Number(g.count) }, () => ({
      id: `\u0001lead:${(leadKey += 1)}`,
      channel: g.channel,
      qualified: g.qualified,
      opportunity: g.opportunity,
    })),
  );

  const stageRows = period.stageGroups.flatMap((g) =>
    g.ids.split(ID_SEPARATOR).map((opportunityExternalId) => ({
      stage: g.stage,
      opportunityExternalId,
      platform: g.platform,
    })),
  );
  const reachedStages = new Map(Object.entries(ctx.membership).map(([stage, ids]) => [stage, new Set(ids)]));

  /*
   * Per event stage, counted in the database: the deals reaching it in the
   * window, those of them that ever reached the stage before it, and those
   * declined after their last arrival at it. Three integers per stage where
   * this read every (stage, deal) pair of the window and every deal's last
   * decline to count them here (30 October 2026). "After" compares
   * milliseconds, as the comparison in JavaScript it replaces did.
   *
   * A previous stage nobody has ever reached leaves the count at every deal,
   * as before: there is no population to narrow by.
   */
  const progression: MonthlyPerformance['progression'] = {};
  const eventStages = stages.filter((st) => (st.source ?? 'stage_events') === 'stage_events');
  const previousKeys = eventStages.map((_, i) => (i === 0 ? null : (eventStages[i - 1]?.key ?? null)));
  const byStage = new Map(period.progression.map((r) => [r.stage, r]));
  for (const [index, stage] of eventStages.entries()) {
    const row = byStage.get(stage.key);
    progression[stage.key] = {
      reached: Number(row?.reached ?? 0),
      previous: previousKeys[index] ?? null,
      alsoPrevious: Number(row?.also_previous ?? 0),
      laterLost: Number(row?.later_lost ?? 0),
    };
  }

  // Funded amount per opportunity, for the value-volume column; and the
  // highest offer per deal at the stage before value, for the offered amount
  // beside the deals reaching it.
  const amounts = new Map<string, number>();
  for (const row of period.amounts) amounts.set(row.externalId, Number(row.fundedAmount ?? row.amount ?? 0));
  const offeredStage = stageBeforeValue(stages)?.key ?? null;
  const offers = new Map<string, number>();
  for (const row of period.offers) if (row.maxOfferAmount !== null) offers.set(row.externalId, Number(row.maxOfferAmount));
  const offeredOf = (platform: string | null | typeof ANY): OfferedAmount => {
    const ids = new Set(
      stageRows
        .filter((r) => r.stage === offeredStage && (platform === ANY || (r.platform ?? null) === platform))
        .map((r) => r.opportunityExternalId),
    );
    let amount = 0;
    let deals = 0;
    for (const id of ids) {
      const offer = offers.get(id);
      if (offer === undefined) continue;
      amount += offer;
      deals += 1;
    }
    return { amount, deals };
  };

  const stageHistoryWindow = windowRows.find((r) => r.factKey === 'window:salesforce:stage_history')?.asOf ?? null;

  const verdictCount = (key: string) => Number(verdictRows.find((r) => r.verdict === key)?.count ?? 0);
  const qualified = verdictCount('qualified');
  const unqualified = verdictCount('unqualified');
  const undeterminable = verdictCount('undeterminable');
  const verdictTotal = verdictRows.reduce((sum, r) => sum + Number(r.count), 0);

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

  /*
   * Cohorts, per population: the records at each stage in the window, and
   * whether each has reached every later stage at any time so far. A lead
   * answers for an opportunity stage through the opportunity it became. The
   * population is fixed by the earlier stage's record, so a channel's rate
   * is its own records throughout.
   */
  const ALL = '\u0000all';
  const NONE = '\u0000none';
  const inWindowBy = new Map<string, Map<string, Set<string>>>();
  const add = (population: string, stage: string, id: string) => {
    for (const key of [population, ALL]) {
      const byStage = inWindowBy.get(key) ?? inWindowBy.set(key, new Map()).get(key)!;
      (byStage.get(stage) ?? byStage.set(stage, new Set()).get(stage)!).add(id);
    }
  };
  const sourceOf = new Map(stages.map((st) => [st.key, st.source ?? 'stage_events']));
  // A lead-grain stage is counted from `leads` alone, as its card is: MQL
  // also has computed stage events, and folding those in counted it twice.
  for (const row of stageRows) {
    if (sourceOf.get(row.stage) !== 'stage_events') continue;
    add(row.platform ?? NONE, row.stage, row.opportunityExternalId);
  }
  const leadOpportunity = new Map<string, string | null>();
  const qualifiedLeads = new Set<string>();
  for (const lead of cohortLeads) {
    leadOpportunity.set(lead.id, lead.opportunity);
    if (lead.qualified) qualifiedLeads.add(lead.id);
    for (const stage of leadStages) {
      if (stage.source === 'qualified_leads' && !lead.qualified) continue;
      add(lead.channel || NONE, stage.key, lead.id);
    }
  }
  const hasReached = (stage: string, id: string) => {
    const source = sourceOf.get(stage);
    if (source === 'leads') return leadOpportunity.has(id);
    if (source === 'qualified_leads') return qualifiedLeads.has(id);
    const opportunity = leadOpportunity.has(id) ? leadOpportunity.get(id) : id;
    return opportunity ? (reachedStages.get(stage)?.has(opportunity) ?? false) : false;
  };
  const cohortsFor = (population: string) =>
    stageCohorts(stages, inWindowBy.get(population) ?? new Map(), hasReached);

  const sumAmounts = (ids: Iterable<string>) =>
    [...ids].reduce((sum, id) => sum + (amounts.get(id) ?? 0), 0);

  // Every platform that has either spend or attributed deals in the window.
  const platforms = [
    ...new Set([
      ...spendRows.map((r) => r.platform),
      ...byPlatform.keys(),
      ...[...leadCounts.values()].flatMap((c) => [...c.byPlatform.keys()]),
    ]),
  ]
    // Ad channels first, so they keep the first chart colours whatever
    // vendors a period happens to have; then the sources with no spend.
    .sort((a, b) => sourceRank(a) - sourceRank(b) || platformLabel(a).localeCompare(platformLabel(b)));

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

    const paid = isPaidChannel(platform);
    const cost = channelCostPerDeal({
      channelSpend: spend,
      attributedDeals,
      unattributedDeals: unattributedDealCount,
      dealsAttributedElsewhere: dealsElsewhere,
    });
    return {
      kind: 'channel',
      platform,
      label: platformLabel(platform),
      paid,
      spend,
      impressions,
      clicks,
      ctr: impressions === 0 ? null : clicks / impressions,
      cpc: clicks === 0 ? null : spend / clicks,
      stages: byPlatform.get(platform) ?? {},
      cohorts: cohortsFor(platform),
      valueVolume: sumAmounts(valueDealsByPlatform.get(platform) ?? []),
      offered: offeredOf(platform),
      // An unpaid channel keeps its deal counts and has no cost: a value of
      // $0 would read as the cheapest channel in the table.
      costPerDeal: paid ? cost : { ...cost, value: null, plausibleRange: { low: null, high: null } },
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
      label: 'Direct & other',
      stages: unattributedStages,
      cohorts: cohortsFor(NONE),
      valueVolume: sumAmounts(unattributedValueDeals),
      offered: offeredOf(null),
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
      cohorts: cohortsFor(ALL),
      valueVolume:
        channels.reduce((sum, c) => sum + c.valueVolume, 0) + sumAmounts(unattributedValueDeals),
      offered: offeredOf(ANY),
      costPerDeal: null,
      costPerDealAbsentBecause: ALL_SOURCES_ELSEWHERE,
    },
    organicMeasured: parseLeadSourceRules(organicRule?.value) !== null,
    dataThrough: latestSync?.finishedAt ?? null,
    declines: {
      deals: Number(declineRow?.deals ?? 0),
      events: Number(declineRow?.events ?? 0),
      byMonth: declineMonths.map((r) => ({ month: r.month, deals: Number(r.deals) })),
    },
    progression,
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
            month: sql<string>`to_char(${schema.stageEvents.occurredOn}, 'YYYY-MM')`,
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
              gte(schema.stageEvents.occurredOn, from),
              countedStageEvent(),
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

/* ------------------------------------------------------------------------- */
/* Lender submissions                                                       */
/* ------------------------------------------------------------------------- */

export type LenderRow = {
  lenderExternalId: string | null;
  label: string;
  offers: SubmissionOfferRate;
  /** This lender's undecided submissions, by where they stand (`pendingState`). */
  pending: PendingTally;
};

export type SubmissionReport = {
  range: DateRange;
  /**
   * Every lender's submissions in the window, together.
   *
   * The window is on the submission date, so a submission made inside it and
   * still unanswered is `undecided` here rather than missing — which is the
   * honest reading and the reason `undecided` is on the metric rather than in a
   * caption.
   */
  overall: SubmissionOfferRate;
  /**
   * The undecided submissions, by where they stand. Sums to
   * `overall.undecided`; `waiting` is the only part anybody is waiting on.
   */
  pending: PendingTally;
  /** One row per lender, each rate over that lender's own decisions. */
  lenders: LenderRow[];
  /**
   * Why the undecided submissions are undecided.
   *
   * Open and failed are both outside the denominator and are not the same
   * fact: a pipeline awaiting answers is normal, submissions that never
   * completed are a problem, and an unclassified status is a mapping gap.
   */
  undecided: { reason: string; count: number }[];
  /** Reason citations over the declines in the window. */
  citations: ReasonCitations;
  /**
   * Reason coverage per month across the whole record, not just the window.
   *
   * The field is being adopted, so the trend is the point and a window would
   * hide it. Deliberately never summed.
   */
  reasonCoverage: ReasonCoverage[];
  /**
   * Offer rate per month, for the KPI card's mini chart.
   *
   * A month where no lender decided anything carries null rather than zero —
   * the chart leaves the bucket blank instead of plotting a rate nobody
   * measured.
   */
  monthly: { month: string; label: string; rate: number | null; decided: number }[];
  /** The first submission on record, as the horizon on all of the above. */
  from: string | null;
  /** True when the tenant has no submission data at all. */
  empty: boolean;
};

/**
 * Submissions for one window, at lender grain.
 *
 * Separate from `monthlyPerformance` because it answers a different question
 * about a different population: that one counts deals through stages, this one
 * counts lender answers. Joining them would invite exactly the cross-grain
 * division that produced a 58.8% offer rate.
 */
export async function submissionReport(
  session: TenantSession,
  range: DateRange,
): Promise<SubmissionReport> {
  return queryTenant(session, async (tx) => {
    const inWindow = and(
      eq(schema.submissions.tenantId, session.tenant.id),
      submissionsIn(range),
    );

    const [byLender, undecidedRows, declineRows, coverageRows, [firstRow], monthlyRows] =
      await Promise.all([
      // With the deal's closed flag, because an open lender status on a deal
      // Salesforce has closed is nobody waiting — see `pendingState`.
      tx
        .select({
          lenderExternalId: schema.submissions.lenderExternalId,
          lenderName: schema.submissions.lenderName,
          outcome: schema.submissions.outcome,
          undecidedReason: schema.submissions.undecidedReason,
          dealClosed: schema.opportunities.isClosed,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.submissions)
        .leftJoin(
          schema.opportunities,
          and(
            eq(schema.opportunities.tenantId, schema.submissions.tenantId),
            eq(schema.opportunities.externalId, schema.submissions.opportunityExternalId),
          ),
        )
        .where(inWindow)
        .groupBy(
          schema.submissions.lenderExternalId,
          schema.submissions.lenderName,
          schema.submissions.outcome,
          schema.submissions.undecidedReason,
          schema.opportunities.isClosed,
        ),

      tx
        .select({
          reason: schema.submissions.undecidedReason,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.submissions)
        .where(and(inWindow, eq(schema.submissions.outcome, 'undecided')))
        .groupBy(schema.submissions.undecidedReason)
        .orderBy(sql`count(*) desc`),

      tx
        .select({ reasons: schema.submissions.declineReasons })
        .from(schema.submissions)
        .where(and(inWindow, eq(schema.submissions.outcome, 'declined'))),

      // Every month on record, not only the window: the adoption curve is the
      // finding, and a 90-day window would show its tail as if it were a level.
      tx
        .select({
          month: sql<string>`to_char(${schema.submissions.submittedOn}, 'YYYY-MM')`,
          declined: sql<number>`count(*)::int`,
          withReason: sql<number>`count(${schema.submissions.declineReasons})::int`,
        })
        .from(schema.submissions)
        .where(
          and(
            eq(schema.submissions.tenantId, session.tenant.id),
            eq(schema.submissions.outcome, 'declined'),
          ),
        )
        .groupBy(sql`1`)
        .orderBy(sql`1`),

      tx
        .select({
          day: sql<string | null>`to_char(min(${schema.submissions.submittedOn}), 'YYYY-MM-DD')`,
        })
        .from(schema.submissions)
        .where(eq(schema.submissions.tenantId, session.tenant.id)),

      // Every month on record, for the trend. Not windowed: a mini chart that
      // only covers the window has nothing to be a trend against.
      tx
        .select({
          month: sql<string>`to_char(${schema.submissions.submittedOn}, 'YYYY-MM')`,
          outcome: schema.submissions.outcome,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.submissions)
        .where(eq(schema.submissions.tenantId, session.tenant.id))
        .groupBy(sql`1`, schema.submissions.outcome)
        .orderBy(sql`1`),
    ]);

    const totals = { offered: 0, declined: 0, undecided: 0 };
    const pending: PendingTally = { ...EMPTY_PENDING };
    const perLender = new Map<
      string,
      { label: string; id: string | null; tally: typeof totals; pending: PendingTally }
    >();

    for (const row of byLender) {
      const n = Number(row.count);
      totals[row.outcome] += n;
      const state = row.outcome === 'undecided' ? pendingState(row.undecidedReason, row.dealClosed) : null;
      if (state) pending[state] += n;
      // Grouped by id, not by name: two lenders can share a name and one
      // lender can be renamed, and a rate is per lender either way.
      const key = row.lenderExternalId ?? '(none)';
      const entry =
        perLender.get(key) ??
        perLender
          .set(key, {
            label: row.lenderName ?? 'Lender not named',
            id: row.lenderExternalId,
            tally: { offered: 0, declined: 0, undecided: 0 },
            pending: { ...EMPTY_PENDING },
          })
          .get(key)!;
      entry.tally[row.outcome] += n;
      if (state) entry.pending[state] += n;
      if (row.lenderName) entry.label = row.lenderName;
    }

    const lenders = [...perLender.values()]
      .map((entry) => ({
        lenderExternalId: entry.id,
        label: entry.label,
        offers: submissionOfferRate(entry.tally),
        pending: entry.pending,
      }))
      // Most decisions first: a lender with two answers and a 50% rate is not
      // the most informative row on the card.
      .sort((a, b) => b.offers.decided - a.offers.decided || a.label.localeCompare(b.label));

    return {
      range,
      overall: submissionOfferRate(totals),
      pending,
      lenders,
      undecided: undecidedRows.map((row) => ({
        reason: row.reason ?? 'no reason recorded',
        count: Number(row.count),
      })),
      citations: rankReasonCitations(declineRows.map((row) => ({ reasons: row.reasons }))),
      reasonCoverage: reasonCoverageByPeriod(
        Object.fromEntries(
          coverageRows.map((row) => [
            row.month,
            { declined: Number(row.declined), withReason: Number(row.withReason) },
          ]),
        ),
      ),
      monthly: (() => {
        const tallies = new Map<string, { offered: number; declined: number; undecided: number }>();
        for (const row of monthlyRows) {
          const tally =
            tallies.get(row.month) ??
            tallies.set(row.month, { offered: 0, declined: 0, undecided: 0 }).get(row.month)!;
          tally[row.outcome] += Number(row.count);
        }
        return [...tallies]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, tally]) => {
            const rate = submissionOfferRate(tally);
            const [year, m] = month.split('-');
            return {
              month,
              label: new Date(Date.UTC(Number(year), Number(m) - 1, 1)).toLocaleDateString(
                'en-US',
                { month: 'short', year: '2-digit', timeZone: 'UTC' },
              ),
              rate: rate.rate,
              decided: rate.decided,
            };
          });
      })(),
      from: firstRow?.day ?? null,
      empty: byLender.length === 0 && firstRow?.day == null,
    };
  });
}

/* ------------------------------------------------------------------------- */
/* Call tracking                                                             */
/* ------------------------------------------------------------------------- */

export type CallReport = {
  range: DateRange;
  /** Connected, attempted and abandoned over the window. */
  volume: CallVolume;
  /**
   * Completed calls that talked for less than the connected threshold.
   *
   * Counted inside `attempted`, surfaced separately because the number is the
   * finding: something answered and the call was over in seconds.
   */
  answeredBriefly: number;
  /** The threshold that decides connected, so the figure carries its rule. */
  connectedMinTalkSeconds: number;
  /**
   * How many calls could be attached to a lead, and why the rest could not.
   *
   * Coverage first, because every figure below it is computed over the matched
   * subset and means nothing without it.
   */
  match: {
    total: number;
    matched: number;
    /** A usable ten-digit key that belongs to no lead in the CRM. */
    unmatchedNoLead: number;
    /** A number that could not be reduced to a key at all. */
    unkeyable: number;
    /** Share of calls carrying a lead, or null with no calls. */
    coverage: number | null;
  };
  /**
   * Time from lead creation to first outbound call, on the tenant's clock —
   * `lead_response_hours` when it is configured, 24/7 when it is not.
   * `withinFiveMinutes` is on the same clock: a response-time figure on a
   * different clock from the median beside it would be two definitions of
   * one word.
   */
  speed: SpeedToLead;
  /**
   * The same leads on the 24/7 clock, kept beside the business-hours figure
   * so the change of clock is traceable on the card rather than in a commit.
   * Identical to `speed` when no hours are configured.
   */
  speedAllHours: SpeedToLead;
  /** The clock `speed` is on, in words — "business hours · 9–6 ET, Mon–Fri". */
  clock: string;
  /** Whether `speed` is on business hours rather than 24/7. */
  businessHours: boolean;
  /** Outbound attempts per lead, over leads that were called. */
  attempts: AttemptsPerLead;
  /** Calls per month, for the trend. */
  monthly: { month: string; label: string; connected: number; attempted: number; abandoned: number }[];
  /** The first call on record, as the horizon. */
  from: string | null;
  empty: boolean;
};

/**
 * The desk's hours, from the `lead_response_hours` row, or null for 24/7.
 *
 * Read inside the report's own transaction rather than passed in, so no screen
 * can compute speed to lead on a clock the card does not state.
 */
async function responseHours(tx: Database, tenantId: string): Promise<BusinessHours | null> {
  const [row] = await tx
    .select({ value: schema.tenantConfig.value })
    .from(schema.tenantConfig)
    .where(
      and(eq(schema.tenantConfig.tenantId, tenantId), eq(schema.tenantConfig.key, 'lead_response_hours')),
    )
    .limit(1);
  return parseBusinessHours(row?.value);
}

/** Epoch seconds as SQL returns them, back to an instant. */
function instant(epoch: number | string): Date {
  return new Date(Number(epoch) * 1000);
}

/**
 * Calls for one window, with the lead join's coverage.
 *
 * Separate from `monthlyPerformance` for the same reason `submissionReport` is:
 * it counts a different thing over a different population, and joining them in
 * one query would invite dividing one by the other.
 */
export async function callReport(
  session: TenantSession,
  range: DateRange,
  connectedMinTalkSeconds = 30,
): Promise<CallReport> {
  return queryTenant(session, async (tx) => {
    const inWindow = and(
      eq(schema.calls.tenantId, session.tenant.id),
      callsIn(range),
    );

    const [
      outcomeRows,
      matchRows,
      speedRows,
      attemptRows,
      monthlyRows,
      [firstRow],
      [leadCount],
      hours,
    ] = await Promise.all([
        tx
          .select({
            outcome: schema.calls.outcome,
            answeredBriefly: schema.calls.answeredBriefly,
            count: sql<number>`count(*)::int`,
          })
          .from(schema.calls)
          .where(inWindow)
          .groupBy(schema.calls.outcome, schema.calls.answeredBriefly),

        tx
          .select({
            total: sql<number>`count(*)::int`,
            matched: sql<number>`count(${schema.calls.leadExternalId})::int`,
            unkeyable: sql<number>`count(*) filter (where ${schema.calls.contactKey} is null)::int`,
          })
          .from(schema.calls)
          .where(inWindow),

        /*
         * Speed to lead, per lead: the first *outbound* call after the lead was
         * created.
         *
         * Outbound only — an inbound call is the merchant ringing in, which is
         * not a response time. And `> created_at`, so a call that predates its
         * lead does not produce a negative interval that would flatter the
         * desk; `speedToLead` drops those as well, belt and braces.
         *
         * The lead population is the window; the call may fall outside it,
         * because a lead created on the last day of the window and called the
         * next morning was still answered in fourteen hours.
         */
        // The two instants rather than their difference: the business-hours
        // clock needs to know when each fell, not only how far apart they are.
        tx
          .select({
            created: sql<number>`extract(epoch from ${schema.leads.createdAt})::float8`,
            firstCall: sql<number>`extract(epoch from min(${schema.calls.occurredAt}))::float8`,
          })
          .from(schema.leads)
          .innerJoin(
            schema.calls,
            and(
              eq(schema.calls.tenantId, schema.leads.tenantId),
              eq(schema.calls.leadExternalId, schema.leads.externalId),
              eq(schema.calls.direction, 'outbound'),
              sql`${schema.calls.occurredAt} > ${schema.leads.createdAt}`,
              // Abandoned excluded, exactly as in `attempts` below: a call the
              // dialer dropped before an agent was on it is not the desk
              // responding to the lead. Both figures then describe the same
              // population, so the card cannot show two different counts of
              // "leads called".
              sql`${schema.calls.outcome} <> 'abandoned'`,
            ),
          )
          .where(
            and(
              eq(schema.leads.tenantId, session.tenant.id),
              leadsCreatedIn(range),
            ),
          )
          .groupBy(schema.leads.externalId, schema.leads.createdAt),

        // Attempts per lead: outbound, abandoned excluded — an abandoned call
        // is not an attempt the desk made.
        tx
          .select({
            attempts: sql<number>`count(*)::int`,
            connected: sql<number>`count(*) filter (where ${schema.calls.outcome} = 'connected')::int`,
            firstOutcome: sql<string>`(array_agg(${schema.calls.outcome} order by ${schema.calls.occurredAt}))[1]`,
          })
          .from(schema.leads)
          .innerJoin(
            schema.calls,
            and(
              eq(schema.calls.tenantId, schema.leads.tenantId),
              eq(schema.calls.leadExternalId, schema.leads.externalId),
              eq(schema.calls.direction, 'outbound'),
            ),
          )
          .where(
            and(
              eq(schema.leads.tenantId, session.tenant.id),
              leadsCreatedIn(range),
              sql`${schema.calls.outcome} <> 'abandoned'`,
            ),
          )
          .groupBy(schema.leads.externalId),

        tx
          .select({
            month: sql<string>`to_char(${schema.calls.occurredOn}, 'YYYY-MM')`,
            outcome: schema.calls.outcome,
            count: sql<number>`count(*)::int`,
          })
          .from(schema.calls)
          .where(eq(schema.calls.tenantId, session.tenant.id))
          .groupBy(sql`1`, schema.calls.outcome)
          .orderBy(sql`1`),

        tx
          .select({
            day: sql<string | null>`to_char(min(${schema.calls.occurredOn}), 'YYYY-MM-DD')`,
          })
          .from(schema.calls)
          .where(eq(schema.calls.tenantId, session.tenant.id)),

        // Every lead in the window, for speed-to-lead coverage: the ones with
        // no outbound call are the denominator's other half.
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.leads)
          .where(
            and(
              eq(schema.leads.tenantId, session.tenant.id),
              leadsCreatedIn(range),
            ),
          ),

        responseHours(tx, session.tenant.id),
      ]);

    const tally = { connected: 0, attempted: 0, abandoned: 0 };
    let answeredBriefly = 0;
    for (const row of outcomeRows) {
      tally[row.outcome] += Number(row.count);
      if (row.answeredBriefly) answeredBriefly += Number(row.count);
    }

    const total = Number(matchRows[0]?.total ?? 0);
    const matched = Number(matchRows[0]?.matched ?? 0);
    const unkeyable = Number(matchRows[0]?.unkeyable ?? 0);

    const pairs = speedRows
      .map((r) => ({ created: instant(r.created), firstCall: instant(r.firstCall) }))
      .filter((r) => Number.isFinite(r.created.getTime()) && Number.isFinite(r.firstCall.getTime()));
    const onClock = (clock: BusinessHours | null) =>
      pairs.map((r) => ({ seconds: responseSeconds(r.created, r.firstCall, clock) }));
    const leadsInWindow = Number(leadCount?.n ?? 0);
    const notCalled = Math.max(0, leadsInWindow - pairs.length);

    const monthly = (() => {
      const months = new Map<string, { connected: number; attempted: number; abandoned: number }>();
      for (const row of monthlyRows) {
        const entry =
          months.get(row.month) ??
          months.set(row.month, { connected: 0, attempted: 0, abandoned: 0 }).get(row.month)!;
        entry[row.outcome] += Number(row.count);
      }
      return [...months]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, counts]) => {
          const [year, m] = month.split('-');
          return {
            month,
            label: new Date(Date.UTC(Number(year), Number(m) - 1, 1)).toLocaleDateString('en-US', {
              month: 'short',
              year: '2-digit',
              timeZone: 'UTC',
            }),
            ...counts,
          };
        });
    })();

    return {
      range,
      volume: callVolume(tally),
      answeredBriefly,
      connectedMinTalkSeconds,
      match: {
        total,
        matched,
        unmatchedNoLead: total - matched - unkeyable,
        unkeyable,
        coverage: total === 0 ? null : matched / total,
      },
      speed: speedToLead(onClock(hours), notCalled),
      speedAllHours: speedToLead(onClock(null), notCalled),
      clock: clockLabel(hours),
      businessHours: hours !== null,
      attempts: attemptsPerLead(
        attemptRows.map((r) => ({
          attempts: Number(r.attempts),
          connected: Number(r.connected) > 0,
          connectedOnFirst: r.firstOutcome === 'connected',
        })),
      ),
      monthly,
      from: firstRow?.day ?? null,
      empty: total === 0 && firstRow?.day == null,
    };
  });
}

/* ------------------------------------------------------------------------- */
/* Call activity, bucketed                                                   */
/* ------------------------------------------------------------------------- */

export type CallBucket = {
  key: string;
  label: string;
  /** Calls the desk placed or answered. Abandoned is excluded, as everywhere. */
  handled: number;
  connected: number;
  /** Connected over handled, or null where nothing was handled in the bucket. */
  connectRate: number | null;
  /**
   * Median speed to lead for the leads *created* in this bucket, or null where
   * too few were called to have a middle.
   *
   * Bucketed by the lead's creation day rather than by the call's: a lead
   * created on Monday and rung on Tuesday is Monday's response time, and
   * counting it on Tuesday would make a slow Monday look like a slow Tuesday.
   */
  medianSpeedSeconds: number | null;
};

/**
 * Calls and speed to lead per bucket, for the activity mini charts.
 *
 * Separate from `callReport`, which answers the window as a whole. The two
 * agree by construction — both count handled calls the same way, both exclude
 * abandoned from speed to lead, and both take their median from `speedToLead`
 * in core rather than from SQL — because the alternative is a card whose figure
 * and whose sparkline were computed by two different rules.
 *
 * A bucket with no calls is a zero, which is a measurement: the desk made no
 * calls that day. A bucket with too few *called leads* to have a median is
 * null, which is not — `MiniChart` leaves it blank rather than plotting the
 * floor.
 */
export async function callSeries(
  session: TenantSession,
  spans: readonly { key: string; start: string; end: string }[],
  labels: readonly string[],
  minimumForMedian = 1,
): Promise<CallBucket[]> {
  if (spans.length === 0) return [];
  const range = { start: spans[0]!.start, end: spans.at(-1)!.end };

  return queryTenant(session, async (tx) => {

    const [callRows, speedRows, hours] = await Promise.all([
      tx
        .select({
          day: sql<string>`to_char(${schema.calls.occurredOn}, 'YYYY-MM-DD')`,
          outcome: schema.calls.outcome,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.calls)
        .where(
          and(
            eq(schema.calls.tenantId, session.tenant.id),
            callsIn(range),
          ),
        )
        .groupBy(sql`1`, schema.calls.outcome),

      // One row per lead created in the window that was called: the day it was
      // created, and the seconds to the first outbound call. The call itself may
      // fall outside the window — a lead created on the last day and rung the
      // next morning was still answered in fourteen hours.
      tx
        .select({
          day: sql<string>`to_char(${schema.leads.createdOn}, 'YYYY-MM-DD')`,
          created: sql<number>`extract(epoch from ${schema.leads.createdAt})::float8`,
          firstCall: sql<number>`extract(epoch from min(${schema.calls.occurredAt}))::float8`,
        })
        .from(schema.leads)
        .innerJoin(
          schema.calls,
          and(
            eq(schema.calls.tenantId, schema.leads.tenantId),
            eq(schema.calls.leadExternalId, schema.leads.externalId),
            eq(schema.calls.direction, 'outbound'),
            sql`${schema.calls.occurredAt} > ${schema.leads.createdAt}`,
            sql`${schema.calls.outcome} <> 'abandoned'`,
          ),
        )
        .where(
          and(
            eq(schema.leads.tenantId, session.tenant.id),
            leadsCreatedIn(range),
          ),
        )
        .groupBy(sql`1`, schema.leads.externalId, schema.leads.createdAt),

      // The same clock as `callReport`, so a sparkline and the figure above it
      // cannot disagree about what a response time is.
      responseHours(tx, session.tenant.id),
    ]);

    return spans.map((span, i) => {
      const tally = { connected: 0, attempted: 0, abandoned: 0 };
      for (const row of callRows) {
        if (row.day < span.start || row.day > span.end) continue;
        tally[row.outcome] += Number(row.count);
      }
      const volume = callVolume(tally);

      const seconds = speedRows
        .filter((r) => r.day >= span.start && r.day <= span.end)
        .map((r) => ({
          seconds: responseSeconds(instant(r.created), instant(r.firstCall), hours),
        }));
      // `notCalled` is zero here on purpose: the bucket's median is over the
      // leads that were called, and the coverage that qualifies it is stated on
      // the card, over the window, where a reader can see it.
      const speed = speedToLead(seconds, 0);

      return {
        key: span.key,
        label: labels[i] ?? span.key,
        handled: volume.handled,
        connected: volume.connected,
        connectRate: volume.connectRate,
        medianSpeedSeconds:
          speed.called >= minimumForMedian ? speed.medianSeconds : null,
      };
    });
  });
}
