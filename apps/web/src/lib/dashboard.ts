import { and, asc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { leadsCreatedIn, schema, stageEventsIn } from '@zeeraa/db';
import {
  addDays,
  formatCount,
  eachDay,
  previousMonth as previousMonthKey,
  tenantDay,
  rangeCoverage,
  type RangeCoverage,
  bucketLabel,
  assessPopulation,
  improvementDirectionFor,
  isMonthKey,
  evenBucketsIn,
  monthBucketsIn,
  type AttributionModel,
  type DateRange,
  type DayBucket,
  type ImprovementDirection,
  type MonthActual,
  type PopulationVerdict,
  type RampTarget,
} from '@zeeraa/core';
import { queryTenant, type TenantSession } from '@/lib/tenant';
import { platformLabel, type StageCounts } from '@/lib/reporting';
import { sourcesThrough } from '@/lib/coverage';
import {
  NO_REASON_BUCKET,
  declineReasonSummary,
  offerRateSummary,
  reasonLine,
  revenueBandSummary,
  share,
} from '@/lib/quality-measures';

/**
 * The queries behind the dashboard furniture that spec v2 added: a mini chart
 * on every KPI card, a delta against the previous period on every figure, one
 * data-quality card per screen.
 *
 * The table and the funnel still read `reporting.ts`. This module is the
 * series-and-status half, kept separate because it answers a different shape of
 * question: not "what were the totals" but "how did this move, and what is the
 * platform unable to say".
 */

/* ------------------------------------------------------------------------- */
/* Metric configuration                                                      */
/* ------------------------------------------------------------------------- */

export type MetricConfig = {
  key: string;
  label: string;
  formulaKey: string;
  formulaArgs: Record<string, unknown>;
  /**
   * Where green and red come from. Never "up is green": a falling cost per
   * funded deal is an improvement and a falling funded volume is not.
   */
  improvementDirection: ImprovementDirection;
  /** Null unless a target exists *and* is reconciled — see `target` below. */
  target: number | null;
  isNorthStar: boolean;
  needsReconciliation: boolean;
  reconciliationNote: string | null;
  definition: string | null;
};

/**
 * A metric the platform will not render, and why.
 *
 * Distinct from a blocked *stage*: a stage is blocked when nobody stamps it,
 * and every metric over it inherits that. This is the case where the stages
 * are both measured and the metric over them still does not mean what its name
 * says — so it has to be suppressible on its own, by a row, with its own
 * reason. Offer rate is the first instance.
 */
export type MetricBlock = {
  label: string;
  reason: string;
  needed: string | null;
  since: Date;
};

export type Metrics = {
  byKey: Map<string, MetricConfig>;
  northStar: MetricConfig | null;
  /**
   * The improvement direction a KPI card should colour its delta by, or null
   * where configuration declares none. A card with no configured direction
   * renders its delta with a sign and an arrow and no colour, rather than
   * having a developer guess which way is good.
   */
  direction: (key: string) => ImprovementDirection | null;
  /**
   * A target only where the paperwork agrees with itself. `needs_reconciliation`
   * means the engagement states the same figure two ways; a dashed target line
   * reads as a commitment somebody made, and drawing one nobody made is worse
   * than drawing none.
   */
  target: (key: string) => number | null;
  /** The metric-level block on this metric, or null where there is none. */
  blocked: (key: string) => MetricBlock | null;
  /**
   * Whether a figure over this population may render at all.
   *
   * The companion to `direction`, and it resolves the same way: whether a
   * formula needs a population is declared in `@zeeraa/core` beside the
   * function that computes it, and how large the population must be is this
   * tenant's `min_rate_denominator`. A screen passes the denominator it
   * actually divided by and renders what comes back — it never names a formula
   * and never picks a floor, for the same reason it never states a direction.
   */
  population: (key: string, population: number) => PopulationVerdict;
  /**
   * Whether a *baseline* population is large enough to compare against.
   *
   * The same resolution, against the higher of the two floors. A figure over a
   * small population is still a measurement; a change between two of them is
   * not, so the two questions get two answers.
   */
  comparable: (key: string, population: number) => PopulationVerdict;
  /** The floors themselves, for a card or a note that wants to state one. */
  floors: RateFloors;
};

export type RateFloors = {
  /**
   * The smallest denominator a rate may be **compared** against. Below it the
   * figure renders and the delta does not: a comparison needs both sides to
   * mean something, and an offer rate of 58.8% against a previous period of
   * 200% (2 of 1) produced "−70.6%, a regression" about one opportunity.
   */
  compare: number;
  /**
   * The smallest denominator the figure itself may be **drawn** over.
   *
   * Much lower, and the distinction is not fussiness — it is the difference
   * between a screen that works at a one-day range and one that withholds its
   * own headline. Google Ads has nine funded deals attributed to it over
   * ninety days; that is the number this product exists to report, and a floor
   * meant for deltas would have suppressed it. What the render floor stops is
   * the case the executive screen actually hits on a short range: a cost per
   * deal over one or two deals, which moves by half when a third lands.
   */
  render: number;
};

/**
 * Both floors on the population behind a rate, from configuration.
 *
 * A config row rather than a constant because both are judgements about this
 * client's volumes — a lender funding four hundred deals a month would set them
 * differently — while *which* metrics they apply to is a property of the
 * formula and lives in `packages/core/src/population.ts`.
 */
export async function rateFloors(session: TenantSession): Promise<RateFloors> {
  const [row] = await queryTenant(session, (tx) =>
    tx
      .select({ value: schema.tenantConfig.value })
      .from(schema.tenantConfig)
      .where(
        and(
          eq(schema.tenantConfig.tenantId, session.tenant.id),
          eq(schema.tenantConfig.key, 'min_rate_denominator'),
        ),
      )
      .limit(1),
  );
  const value = row?.value as { minimum?: number; render?: number } | undefined;
  const positive = (n: unknown, fallback: number) =>
    typeof n === 'number' && n > 0 ? n : fallback;
  return { compare: positive(value?.minimum, 10), render: positive(value?.render, 3) };
}

/**
 * How much leakage a conversion rate may carry before it is not one.
 *
 * A funnel rate divides deals reaching a later stage by deals reaching an
 * earlier one, which reads as a conversion only if the later population came
 * through the earlier one. `progression` measures whether it did, and it never
 * does perfectly: Spartan has one approved deal out of 114 with no underwriting
 * timestamp, and ten offers out of 67 with no approval at all.
 *
 * Those two need different answers. Suppressing a rate over one stray record
 * replaces a figure that is right to a tenth of a percent with an em dash, and
 * an em dash nobody can act on is its own kind of wrong; rendering a rate whose
 * numerator is 15% strangers is the error this whole audit was about. So the
 * line is a number, and a number that is a judgement about a client's data
 * quality is a config row rather than a constant.
 *
 * Two per cent by default: small enough that the rate is still the same
 * statement, large enough to absorb the handful of records every CRM has.
 */
export async function maxRateLeakage(session: TenantSession): Promise<number> {
  const [row] = await queryTenant(session, (tx) =>
    tx
      .select({ value: schema.tenantConfig.value })
      .from(schema.tenantConfig)
      .where(
        and(
          eq(schema.tenantConfig.tenantId, session.tenant.id),
          eq(schema.tenantConfig.key, 'max_rate_leakage'),
        ),
      )
      .limit(1),
  );
  const share = (row?.value as { share?: number } | undefined)?.share;
  return typeof share === 'number' && share >= 0 && share <= 1 ? share : 0.02;
}

/**
 * The talk-time threshold that separates a connected call from an attempt.
 *
 * A config row, because it is a judgement about what a conversation is rather
 * than a property of the product — and a steep one: the dialer marks nearly
 * every call completed, so at one second 23,355 of Spartan's calls are
 * connected and at thirty seconds 3,503 are. Thirty by default, and rendered
 * on the card beside the figure it decides.
 */
export async function alowareConnectedThreshold(session: TenantSession): Promise<number> {
  const [row] = await queryTenant(session, (tx) =>
    tx
      .select({ value: schema.tenantConfig.value })
      .from(schema.tenantConfig)
      .where(
        and(
          eq(schema.tenantConfig.tenantId, session.tenant.id),
          eq(schema.tenantConfig.key, 'aloware'),
        ),
      )
      .limit(1),
  );
  const seconds = (row?.value as { connectedMinTalkSeconds?: number } | undefined)
    ?.connectedMinTalkSeconds;
  return typeof seconds === 'number' && seconds >= 0 ? seconds : 30;
}

export async function loadMetrics(session: TenantSession): Promise<Metrics> {
  const [{ rows, blocks }, floors] = await Promise.all([
    queryTenant(session, async (tx) => ({
      rows: await tx
        .select()
        .from(schema.tenantMetrics)
        .where(eq(schema.tenantMetrics.tenantId, session.tenant.id))
        .orderBy(asc(schema.tenantMetrics.key)),
      blocks: await tx
        .select()
        .from(schema.blockedDependencies)
        .where(
          and(
            eq(schema.blockedDependencies.tenantId, session.tenant.id),
            eq(schema.blockedDependencies.subjectKind, 'metric'),
          ),
        ),
    })),
    rateFloors(session),
  ]);

  const configs = rows.map(
    (row): MetricConfig => ({
      key: row.key,
      label: row.label,
      formulaKey: row.formulaKey,
      formulaArgs: (row.formulaArgs ?? {}) as Record<string, unknown>,
      improvementDirection: row.improvementDirection,
      target: row.targetValue === null ? null : Number(row.targetValue),
      isNorthStar: row.isNorthStar,
      needsReconciliation: row.needsReconciliation,
      reconciliationNote: row.reconciliationNote,
      definition: row.definition,
    }),
  );

  const byKey = new Map(configs.map((c) => [c.key, c]));
  const blockedByMetric = new Map<string, MetricBlock>(
    blocks.map((row) => [
      row.subjectKey,
      {
        label: row.label,
        reason: row.reason,
        needed: row.needed,
        since: row.blockedSince,
      },
    ]),
  );

  return {
    byKey,
    northStar: configs.find((c) => c.isNorthStar) ?? null,
    /**
     * Which way is better, from the metric's own definition.
     *
     * Resolved from `formula_key` in `@zeeraa/core`, not from the row's
     * `improvement_direction`: the direction is a property of the formula — a
     * falling cost per funded deal is good news for every client — and a config
     * row that said otherwise would paint a rising cost green with nothing to
     * catch it. The configured value is the fallback for a formula core has
     * never heard of, which is how a tenant's own metric still renders.
     *
     * A key with no configuration row at all still resolves, by treating the
     * key as the formula name. `paid_media_spend` has no row and is declared
     * neutral in core, so it renders in `--text-2` by decision rather than by
     * the absence of a row.
     */
    direction: (key) => {
      const metric = byKey.get(key);
      return improvementDirectionFor(
        metric?.formulaKey ?? key,
        metric?.improvementDirection ?? null,
      );
    },
    target: (key) => {
      const metric = byKey.get(key);
      if (!metric || metric.needsReconciliation) return null;
      return metric.target;
    },
    blocked: (key) => blockedByMetric.get(key) ?? null,
    /*
     * Resolved from `formula_key`, exactly as `direction` is, and for the same
     * reason: whether a figure needs a population is a property of the formula
     * rather than of the tenant's name for it. A key with no configuration row
     * falls back to treating the key as the formula name, which is how the
     * activity metrics — `leads_created`, `calls_handled` — resolve.
     */
    population: (key, population) =>
      assessPopulation(byKey.get(key)?.formulaKey ?? key, population, floors.render),
    comparable: (key, population) =>
      assessPopulation(byKey.get(key)?.formulaKey ?? key, population, floors.compare),
    floors,
  };
}

/* ------------------------------------------------------------------------- */
/* Windowed series                                                           */
/* ------------------------------------------------------------------------- */

export type WindowBucket = {
  key: string;
  label: string;
  start: string;
  end: string;
  /**
   * Whether *paid media* was ingested for this bucket.
   *
   * Separate from `crmIngested`, and the distinction is not pedantic: the CRM
   * sync reaches back to 2024 while the ad platforms were first pulled in June
   * 2026. A spend series that plotted zero for the months before that would be
   * claiming the account spent nothing, when in fact nobody looked — and a bar
   * at the axis is a measurement.
   */
  spendIngested: boolean;
  /**
   * Each spend platform's coverage of this bucket, from the day ledger: the
   * days before its record, the unread days inside it, and whether the bucket
   * runs past its last read. A per-channel figure asks its own channel's —
   * a Meta hole must not withhold a Google Ads month.
   */
  spendCoverage: Record<string, RangeCoverage>;
  /** Whether CRM history covers this bucket: leads, stages, attribution. */
  crmIngested: boolean;
  /** Overlaps the trailing seven days, which platforms are still restating. */
  provisional: boolean;
  spend: number;
  clicks: number;
  impressions: number;
  spendByPlatform: Record<string, number>;
  /** Every source, attributed or not. */
  stages: StageCounts;
  /** Per channel. A channel's numerator only ever comes from here. */
  stagesByPlatform: Record<string, StageCounts>;
  unattributedStages: StageCounts;
  /**
   * Funded amount on the value-stage deals in this bucket, per attributed
   * channel. A contracted volume is a channel's, so its actual is too.
   */
  valueVolumeByPlatform: Record<string, number>;
  /** Funded amount on the value-stage deals in this bucket, every source. */
  valueVolume: number;
};

export type Granularity = 'month' | 'week' | 'day';

/**
 * One bucket per month or per week across the window, carrying spend and stage
 * counts split by channel.
 *
 * Deliberately not a ratio per bucket: a cost per deal for a week with one
 * funded deal is not comparable to one for a week with twenty, and the decision
 * about how to present that belongs to the chart. What travels is the two
 * measures, per population, so anything computed downstream can keep both
 * halves inside one channel.
 */
export async function windowBuckets(
  session: TenantSession,
  range: DateRange,
  granularity: Granularity,
  model: AttributionModel = 'last_touch',
): Promise<WindowBucket[]> {
  const spans: DayBucket[] =
    granularity === 'month'
      ? monthBucketsIn(range)
      : evenBucketsIn(range, granularity === 'week' ? 7 : 1);

  const through = await sourcesThrough(session);
  const crmThrough = through.byPlatform.salesforce ?? null;

  return queryTenant(session, async (tx) => {
    const tenantId = session.tenant.id;

    const [stages, spendRows, stageRows, leadRows, firstDaily, firstStage, firstLead] =
      await Promise.all([
      tx
        .select()
        .from(schema.funnelStages)
        .where(eq(schema.funnelStages.tenantId, tenantId))
        .orderBy(asc(schema.funnelStages.position)),

      tx
        .select({
          day: schema.dailyMetrics.date,
          platform: schema.dailyMetrics.platform,
          spend: sql<string>`coalesce(sum(${schema.dailyMetrics.spend}), 0)`,
          clicks: sql<string>`coalesce(sum(${schema.dailyMetrics.clicks}), 0)`,
          impressions: sql<string>`coalesce(sum(${schema.dailyMetrics.impressions}), 0)`,
        })
        .from(schema.dailyMetrics)
        .where(
          and(
            eq(schema.dailyMetrics.tenantId, tenantId),
            gte(schema.dailyMetrics.date, range.start),
            lte(schema.dailyMetrics.date, range.end),
          ),
        )
        .groupBy(schema.dailyMetrics.date, schema.dailyMetrics.platform),

      // One row per (day, stage, opportunity, channel). Distinct because a
      // stage recurs: a deal that funds twice in a bucket is one deal.
      tx
        .selectDistinct({
          day: sql<string>`to_char(${schema.stageEvents.occurredOn}, 'YYYY-MM-DD')`,
          stage: schema.stageEvents.stage,
          opportunityExternalId: schema.stageEvents.opportunityExternalId,
          platform: schema.attribution.platform,
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
            stageEventsIn(range),
          ),
        ),

      // The verdict is part of the grouping because a lead-grain stage may be
      // the whole population (`leads`) or the part of it that passes the bar
      // (`qualified_leads`), and both are counted from these rows.
      tx
        .select({
          day: sql<string>`to_char(${schema.leads.createdOn}, 'YYYY-MM-DD')`,
          clickIdType: schema.leads.clickIdType,
          verdict: schema.leads.mqlVerdict,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.leads)
        .where(
          and(
            eq(schema.leads.tenantId, tenantId),
            leadsCreatedIn(range),
          ),
        )
        .groupBy(sql`1`, schema.leads.clickIdType, schema.leads.mqlVerdict),

      tx
        .select({ day: sql<string | null>`min(${schema.dailyMetrics.date})::text` })
        .from(schema.dailyMetrics)
        .where(eq(schema.dailyMetrics.tenantId, tenantId)),

      tx
        .select({
          day: sql<string | null>`to_char(min(${schema.stageEvents.occurredOn}), 'YYYY-MM-DD')`,
        })
        .from(schema.stageEvents)
        .where(eq(schema.stageEvents.tenantId, tenantId)),

      tx
        .select({
          day: sql<string | null>`to_char(min(${schema.leads.createdOn}), 'YYYY-MM-DD')`,
        })
        .from(schema.leads)
        .where(eq(schema.leads.tenantId, tenantId)),
    ]);

    /**
     * Funded amount per opportunity, for the value-volume series.
     *
     * A second round trip rather than a join on the stage query: the stage
     * query is already distinct across four columns, and adding a numeric to
     * it would make a deal that funds twice in a bucket contribute its amount
     * twice.
     */
    const valueStageKey = stages.find((s) => s.countsValue)?.key ?? null;
    const valueIds = valueStageKey
      ? [
          ...new Set(
            stageRows.filter((r) => r.stage === valueStageKey).map((r) => r.opportunityExternalId),
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

    // The first day each source covers, across all time. Everything before it
    // is absent from the record rather than zero in it. Per platform where the
    // ledger knows; the earliest spend row otherwise.
    const spendFrom = firstDaily[0]?.day ?? null;
    const coverageOf = (platform: string, span: DayBucket): RangeCoverage => {
      const clipped = { start: span.start, end: span.end < range.end ? span.end : range.end };
      const first = through.from?.[platform] ?? spendFrom;
      const lastRead = through.byPlatform[platform] ?? null;
      if (first === null || lastRead === null) return rangeCoverage(clipped, null);
      // Days before the record are unread for this bucket, not zero.
      const beforeRecord = clipped.start < first
        ? eachDay({ start: clipped.start, end: clipped.end < first ? clipped.end : addDays(first, -1) })
        : [];
      return rangeCoverage(clipped, lastRead, [...beforeRecord, ...(through.unread?.[platform] ?? [])]);
    };
    const crmFrom =
      [firstStage[0]?.day, firstLead[0]?.day].filter((d): d is string => Boolean(d)).sort()[0] ??
      null;

    const leadGrainStages = stages
      .filter((s) => s.source === 'leads' || s.source === 'qualified_leads')
      .map((s) => ({ key: s.key, qualifiedOnly: s.source === 'qualified_leads' }));
    const leadGrainKeys = new Set(leadGrainStages.map((s) => s.key));
    const settledBefore = addDays(range.end, -6);

    return spans.map((span) => {
      const bucket: WindowBucket = {
        key: span.key,
        label: bucketLabel(span, granularity === 'month' ? 'month' : 'day'),
        start: span.start,
        end: span.end,
        // Ingested means inside the record at both ends: after the first
        // day the source covers, and not starting after its last read. A
        // bucket past the last sync is unmeasured, not a bucket of zeros.
        // Ingested means every spend platform read every day of the bucket up
        // to its last read: no hole, no day before its record. Running past
        // the last read is still ingested — the figure stops early and the
        // screen says where — but a hole is not, because a total over a hole
        // is a smaller number that looks like a quiet day.
        spendCoverage: Object.fromEntries(
          through.spendPlatforms.map((p) => [p, coverageOf(p, span)]),
        ),
        spendIngested:
          through.spendPlatforms.length > 0 &&
          through.spendPlatforms.every((p) => {
            const c = coverageOf(p, span);
            return (c.state === 'full' || c.state === 'partial') && c.missing.length === 0;
          }),
        crmIngested:
          crmFrom !== null && span.end >= crmFrom && crmThrough !== null && span.start <= crmThrough,
        provisional: span.end >= settledBefore,
        spend: 0,
        clicks: 0,
        impressions: 0,
        spendByPlatform: {},
        stages: {},
        stagesByPlatform: {},
        unattributedStages: {},
        valueVolume: 0,
        valueVolumeByPlatform: {},
      };
      const counted = new Set<string>();

      for (const row of spendRows) {
        if (row.day < span.start || row.day > span.end) continue;
        const spend = Number(row.spend);
        bucket.spend += spend;
        bucket.clicks += Number(row.clicks);
        bucket.impressions += Number(row.impressions);
        bucket.spendByPlatform[row.platform] =
          (bucket.spendByPlatform[row.platform] ?? 0) + spend;
      }

      /*
       * One deal counted once per stage per bucket.
       *
       * The rows are distinct on (day, stage, opportunity, platform), so a
       * deal that reaches a stage on two days inside one bucket arrives twice
       * — and a stage that recurs by nature makes that common rather than
       * exotic. Declines were 555 over a window in which only 554 deals have
       * ever been declined, which is the tell: the figure was counting
       * deal-days under a label that says deals.
       */
      const seenInBucket = new Set<string>();

      for (const row of stageRows) {
        if (row.day < span.start || row.day > span.end) continue;
        // A lead-grain stage (MQL) is counted from `leads` below, as
        // `monthlyPerformance` counts it. Its stage events are the subset that
        // became deals, and adding them too counted those MQLs twice — found by
        // the cross-screen number check, 24 September 2026.
        if (leadGrainKeys.has(row.stage)) continue;
        const key = `${row.stage}\u0000${row.opportunityExternalId}`;
        if (seenInBucket.has(key)) continue;
        seenInBucket.add(key);

        bucket.stages[row.stage] = (bucket.stages[row.stage] ?? 0) + 1;
        if (row.platform) {
          const counts = (bucket.stagesByPlatform[row.platform] ??= {});
          counts[row.stage] = (counts[row.stage] ?? 0) + 1;
        } else {
          bucket.unattributedStages[row.stage] =
            (bucket.unattributedStages[row.stage] ?? 0) + 1;
        }

        // One deal, one amount, however many times it reached the stage in the
        // bucket.
        if (row.stage === valueStageKey && !counted.has(row.opportunityExternalId)) {
          counted.add(row.opportunityExternalId);
          const amount = amounts.get(row.opportunityExternalId) ?? 0;
          bucket.valueVolume += amount;
          if (row.platform) {
            bucket.valueVolumeByPlatform[row.platform] =
              (bucket.valueVolumeByPlatform[row.platform] ?? 0) + amount;
          }
        }
      }

      // Lead-grain stages are counted from `leads`, because a lead that never
      // became an opportunity has no opportunity to attribute through.
      for (const row of leadRows) {
        if (row.day < span.start || row.day > span.end) continue;
        const count = Number(row.count);
        for (const { key, qualifiedOnly } of leadGrainStages) {
          if (qualifiedOnly && row.verdict !== 'qualified') continue;
          bucket.stages[key] = (bucket.stages[key] ?? 0) + count;
          if (row.clickIdType) {
            const counts = (bucket.stagesByPlatform[row.clickIdType] ??= {});
            counts[key] = (counts[key] ?? 0) + count;
          } else {
            bucket.unattributedStages[key] = (bucket.unattributedStages[key] ?? 0) + count;
          }
        }
      }

      return bucket;
    });
  });
}

/* ------------------------------------------------------------------------- */
/* Data quality                                                              */
/* ------------------------------------------------------------------------- */

export type DataQualityItem = {
  key: string;
  name: string;
  status:
    | 'not_measured'
    | 'waiting_on_client'
    | 'degraded'
    | 'unreconciled'
    | 'corrected'
    | 'not_configured'
    /** A figure the platform does measure, stated with its coverage. */
    | 'measured';
  /** One line. The full explanation goes in the ⓘ, never inline. */
  summary: string;
  detail: string;
  since: Date | null;
};

const STATUS_ORDER: Record<DataQualityItem['status'], number> = {
  not_measured: 0,
  degraded: 1,
  waiting_on_client: 2,
  unreconciled: 3,
  corrected: 4,
  not_configured: 5,
  measured: 6,
};

/**
 * Everything the platform cannot currently say, as one-line rows.
 *
 * The only place blocked items are listed in full (spec v2 §6). A missing data
 * dependency is an explicit state here rather than a silent gap on the screen
 * that needed it: a visible dependency is a conversation, and a gap looks like
 * the agency failed.
 */
export async function dataQuality(session: TenantSession): Promise<DataQualityItem[]> {
  const [blocked, connections, metrics, runs, corrections] = await Promise.all([
    queryTenant(session, (tx) =>
      tx
        .select()
        .from(schema.blockedDependencies)
        .where(eq(schema.blockedDependencies.tenantId, session.tenant.id))
        .orderBy(asc(schema.blockedDependencies.key)),
    ),
    queryTenant(session, (tx) =>
      tx
        .select()
        .from(schema.connections)
        .where(eq(schema.connections.tenantId, session.tenant.id))
        .orderBy(asc(schema.connections.platform)),
    ),
    queryTenant(session, (tx) =>
      tx
        .select()
        .from(schema.tenantMetrics)
        .where(
          and(
            eq(schema.tenantMetrics.tenantId, session.tenant.id),
            eq(schema.tenantMetrics.needsReconciliation, true),
          ),
        )
        .orderBy(asc(schema.tenantMetrics.key)),
    ),

    /**
     * The latest finished run per platform *and trigger*, for its reason.
     *
     * Partitioned by trigger, not by platform alone. One platform runs several
     * distinct jobs — the Salesforce sync and the converted-Lead click-ID
     * backfill both write `platform = 'salesforce'` — and the backfill
     * succeeding says nothing about a field the sync found missing. Ranking by
     * platform alone let the newer, clean backfill mask the sync's reason.
     *
     * The connection row holds a *dependency*, something the client has to do.
     * A run's `error` holds what the last attempt actually found, which is the
     * only thing that stays true after `set-credentials` clears the dependency.
     */
    queryTenant(session, (tx) =>
      tx
        .select({
          platform: schema.syncRuns.platform,
          error: schema.syncRuns.error,
          rank: sql<number>`row_number() over (
            partition by ${schema.syncRuns.platform}, ${schema.syncRuns.trigger}
            order by ${schema.syncRuns.finishedAt} desc
          )`.as('rank'),
        })
        .from(schema.syncRuns)
        .where(
          and(
            eq(schema.syncRuns.tenantId, session.tenant.id),
            isNotNull(schema.syncRuns.finishedAt),
          ),
        ),
    ),

    /**
     * Stage dates a person corrected over the CRM's.
     *
     * A corrected event is neither observed nor computed, so it is listed here
     * where a reader can see it and its source, rather than folded silently
     * into a month's count.
     */
    queryTenant(session, (tx) =>
      tx
        .select({
          stage: schema.stageEvents.stage,
          occurredOn: schema.stageEvents.occurredOn,
          precision: schema.stageEvents.occurredPrecision,
          source: schema.stageEvents.correctionSource,
          opportunity: schema.stageEvents.opportunityExternalId,
        })
        .from(schema.stageEvents)
        .where(
          and(
            eq(schema.stageEvents.tenantId, session.tenant.id),
            eq(schema.stageEvents.origin, 'corrected'),
          ),
        )
        .orderBy(asc(schema.stageEvents.occurredOn)),
    ),
  ]);

  // Every current job outcome that has something to say, per platform.
  const runError = new Map<string, string>();
  for (const row of runs) {
    if (Number(row.rank) !== 1 || !row.error) continue;
    const existing = runError.get(row.platform);
    runError.set(row.platform, existing ? `${existing} ${row.error}` : row.error);
  }

  const items: DataQualityItem[] = [
    ...blocked.map(
      (row): DataQualityItem => ({
        key: `blocked:${row.key}`,
        name: row.label,
        status: 'not_measured',
        summary: firstSentence(row.reason),
        detail: [row.reason, row.needed && `Needed: ${row.needed}`, row.evidence]
          .filter(Boolean)
          .join(' '),
        since: row.blockedSince,
      }),
    ),
    ...connections
      .filter((c) => c.status === 'waiting_on_client' || c.status === 'degraded')
      .map((row): DataQualityItem => {
        /**
         * Never invent a reason.
         *
         * This said "Connection unavailable" whenever nothing was stored, which
         * for Salesforce was a fabrication: the connection authenticates and
         * syncs, and one mapped field is absent from the org — the opposite of
         * unavailable. The seed had put the real reason on the connection row
         * and `set-credentials` then cleared it, correctly, because the
         * credential was the dependency it was tracking. That left a `degraded`
         * status with no explanation and this string filled the hole.
         *
         * Order of authority: the dependency on the connection row, then what
         * the last run of each job actually found, then an explicit admission
         * that nothing recorded a reason.
         */
        const recorded = row.blockedReason ?? row.lastError ?? runError.get(row.platform) ?? null;
        const state = row.status.replace(/_/g, ' ');
        return {
          key: `connection:${row.platform}`,
          name: platformLabel(row.platform),
          status: row.status === 'degraded' ? 'degraded' : 'waiting_on_client',
          summary: recorded
            ? firstSentence(recorded)
            : `Marked ${state}, with no reason recorded against it.`,
          detail:
            recorded ??
            `The connection is marked ${state}, but neither the connection row nor the ` +
              'most recent run of any of its jobs records why. Run the sync to refresh it.',
          since: row.blockedSince ?? null,
        };
      }),
    ...corrections.map((row): DataQualityItem => {
      const when = row.occurredOn
        ? row.precision === 'month'
          ? `${new Date(`${row.occurredOn}T00:00:00Z`).toLocaleDateString('en-US', {
              month: 'long',
              year: 'numeric',
              timeZone: 'UTC',
            })}, day unknown`
          : row.occurredOn
        : 'an unrecorded date';
      return {
        key: `corrected:${row.opportunity}:${row.stage}`,
        name: `${row.stage.replace(/_/g, ' ')} date corrected`,
        status: 'corrected',
        summary: `One deal counted in ${when}, not where the CRM dates it.`,
        detail: row.source ?? 'Corrected by hand; no source recorded.',
        since: null,
      };
    }),
    ...metrics.map(
      (row): DataQualityItem => ({
        key: `metric:${row.key}`,
        name: `${row.label} target`,
        status: 'unreconciled',
        summary: 'Stated two ways in the engagement paperwork; no target is drawn.',
        detail: row.reconciliationNote ?? '',
        since: null,
      }),
    ),
  ];

  items.push(...(await measuredItems(session)));

  return items.sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
  );
}

/**
 * Three figures this card used to list as not measurable, now measured over
 * the last 90 days and stated with their coverage (24 September 2026). Each is
 * left out for a tenant with no data behind it — no lender submissions, no
 * revenue bands stored — rather than rendered as a zero.
 */
async function measuredItems(session: TenantSession): Promise<DataQualityItem[]> {
  const today = tenantDay(new Date(), session.tenant.timezone);
  const range = { start: addDays(today, -89), end: today };
  const [offers, bands, declines] = await Promise.all([
    offerRateSummary(session, range),
    revenueBandSummary(session, range),
    declineReasonSummary(session, range),
  ]);
  const out: DataQualityItem[] = [];

  if (offers.decided > 0) {
    out.push({
      key: 'measured:offer_rate',
      name: 'Offer rate',
      status: 'measured',
      summary: `${share(offers.offered, offers.decided)} of lender decisions were offers · last 90 days`,
      detail:
        `${formatCount(offers.offered)} offers out of ${formatCount(offers.decided)} lender decisions, counted per lender: ` +
        offers.lenders
          .filter((l) => l.decided > 0)
          .map((l) => `${l.name} ${share(l.offered, l.decided)} (${formatCount(l.offered)} of ${formatCount(l.decided)})`)
          .join(', ') +
        `. ${formatCount(offers.waiting)} submissions are still waiting on a lender reply and are not counted.`,
      since: null,
    });
  }

  if (bands.placed + bands.spansBands + bands.categorical > 0) {
    out.push({
      key: 'measured:revenue_bands',
      name: 'Revenue bands',
      status: 'measured',
      summary: `Band known for ${share(bands.placed, bands.leads)} of inbound leads · last 90 days`,
      detail:
        `One set of bands across every form: ` +
        bands.bands.map((b) => `${b.label} ${formatCount(b.count)}`).join(', ') +
        `. Of ${formatCount(bands.leads)} inbound leads, ${formatCount(bands.spansBands)} gave a range from an older ` +
        `form that spans two bands, ${formatCount(bands.categorical)} said New Business, and ` +
        `${formatCount(bands.unanswered)} did not answer.`,
      since: null,
    });
  }

  if (declines.declined > 0) {
    out.push({
      key: 'measured:decline_reasons',
      name: 'Decline reasons',
      status: 'measured',
      summary: `Reason given on ${share(declines.withReason, declines.declined)} of lender declines · last 90 days`,
      detail:
        `${formatCount(declines.withReason)} of ${formatCount(declines.declined)} lender declines carry a reason, from ` +
        `the lender submission's Decline Reason field — the best-populated place a reason is recorded. ` +
        (declines.reasons.length > 0 ? `Most common: ${reasonLine(declines)}. ` : '') +
        `${NO_REASON_BUCKET}, no reason given: ${formatCount(declines.noReason)}.`,
      since: null,
    });
  }
  return out;
}

/**
 * The first sentence of a reason, for the one-line row.
 *
 * Splits on a full stop followed by whitespace, not on any full stop: the
 * reasons in this product are full of Salesforce API names, and a naive split
 * turns "Opportunity.csbs__Decline_Reason__c does not exist in the org" into
 * "Opportunity." Falls back to the whole text when there is no break.
 */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = /^.*?[.!?](?=\s|$)/s.exec(trimmed);
  const sentence = match?.[0] ?? trimmed;
  // A "sentence" of a few characters is an abbreviation, not a sentence.
  return sentence.length < 24 ? trimmed : sentence;
}

/* ------------------------------------------------------------------------- */
/* Connection health                                                         */
/* ------------------------------------------------------------------------- */

export type ConnectionCard = {
  id: string;
  platform: string;
  label: string;
  status: string;
  /** Null where no run has ever succeeded. */
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  rowsWritten: number | null;
  /**
   * What is actually wrong, in order of authority: the dependency recorded on
   * the connection, then the last run's own explanation of why it was not
   * `succeeded`. Null means nothing is known to be wrong — which is not the
   * same as "unavailable", and must not be rendered as though it were.
   */
  detail: string | null;
  since: Date | null;
};

export async function connectionHealth(session: TenantSession): Promise<ConnectionCard[]> {
  return queryTenant(session, async (tx) => {
    const [connections, runs] = await Promise.all([
      tx
        .select()
        .from(schema.connections)
        .where(eq(schema.connections.tenantId, session.tenant.id))
        .orderBy(asc(schema.connections.platform)),

      // The most recent finished run per platform, whatever its outcome: a run
      // that failed an hour ago is more useful than one that succeeded a week
      // ago, and hiding it would make a broken connector look idle.
      //
      // `trigger` comes back too, because the reason has to be read per job —
      // see the note in `dataQuality`.
      tx
        .select({
          platform: schema.syncRuns.platform,
          trigger: schema.syncRuns.trigger,
          finishedAt: schema.syncRuns.finishedAt,
          status: schema.syncRuns.status,
          rowsWritten: schema.syncRuns.rowsWritten,
          error: schema.syncRuns.error,
          rank: sql<number>`row_number() over (
            partition by ${schema.syncRuns.platform}, ${schema.syncRuns.trigger}
            order by ${schema.syncRuns.finishedAt} desc
          )`.as('rank'),
        })
        .from(schema.syncRuns)
        .where(
          and(
            eq(schema.syncRuns.tenantId, session.tenant.id),
            isNotNull(schema.syncRuns.finishedAt),
          ),
        ),
    ]);

    const current = runs.filter((r) => Number(r.rank) === 1);
    // Newest job per platform, for "last sync" and "rows ingested".
    const latest = new Map<string, (typeof current)[number]>();
    for (const row of current) {
      const held = latest.get(row.platform);
      if (!held || (row.finishedAt?.getTime() ?? 0) > (held.finishedAt?.getTime() ?? 0)) {
        latest.set(row.platform, row);
      }
    }
    // Reasons across every current job, so a clean backfill cannot mask them.
    const reasons = new Map<string, string>();
    for (const row of current) {
      if (!row.error) continue;
      const held = reasons.get(row.platform);
      reasons.set(row.platform, held ? `${held} ${row.error}` : row.error);
    }

    return connections.map((row): ConnectionCard => {
      const run = latest.get(row.platform);
      return {
        id: row.id,
        platform: row.platform,
        label: platformLabel(row.platform),
        status: row.status,
        lastSyncAt: run?.finishedAt ?? null,
        lastSyncStatus: run?.status ?? null,
        rowsWritten: run ? Number(run.rowsWritten) : null,
        detail: row.blockedReason ?? row.lastError ?? reasons.get(row.platform) ?? null,
        since: row.blockedSince ?? null,
      };
    });
  });
}

/* ------------------------------------------------------------------------- */
/* The engagement ramp                                                       */
/* ------------------------------------------------------------------------- */

export type EngagementRamp = {
  /**
   * `YYYY-MM`, or null until the contract is signed. Null is a state the
   * screens render, not a reason to fall back to a guess: assuming the
   * engagement began when ingestion did would report the client against a curve
   * nobody started.
   */
  startMonth: string | null;
  /** Contracted figures by platform. A platform with no ramp has no target. */
  byPlatform: Map<string, RampTarget[]>;
};

/**
 * The contracted curve, and where M1 sits on the calendar.
 *
 * Both halves are configuration and both can be absent independently: a tenant
 * may have a ramp recorded before the start month is decided, which is exactly
 * where Spartan is today.
 */
export async function engagementRamp(session: TenantSession): Promise<EngagementRamp> {
  return queryTenant(session, async (tx) => {
    const tenantId = session.tenant.id;
    const [config, rows] = await Promise.all([
      tx
        .select({ value: schema.tenantConfig.value })
        .from(schema.tenantConfig)
        .where(
          and(
            eq(schema.tenantConfig.tenantId, tenantId),
            eq(schema.tenantConfig.key, 'engagement_start_month'),
          ),
        )
        .limit(1),
      tx
        .select({
          platform: schema.engagementTargets.platform,
          monthIndex: schema.engagementTargets.monthIndex,
          costPerFundedDeal: schema.engagementTargets.costPerFundedDeal,
          budget: schema.engagementTargets.budget,
          cpa: schema.engagementTargets.cpa,
          approvals: schema.engagementTargets.approvals,
          fundedDeals: schema.engagementTargets.fundedDeals,
          fundedAmount: schema.engagementTargets.fundedAmount,
        })
        .from(schema.engagementTargets)
        .where(eq(schema.engagementTargets.tenantId, tenantId))
        .orderBy(asc(schema.engagementTargets.platform), asc(schema.engagementTargets.monthIndex)),
    ]);

    const raw = (config[0]?.value as { month?: unknown } | undefined)?.month;
    // Validated rather than trusted: this is a jsonb column somebody edits by
    // hand, and a malformed value must read as "not set" rather than shift the
    // whole curve onto a month that does not exist.
    const startMonth = typeof raw === 'string' && isMonthKey(raw) ? raw : null;

    const byPlatform = new Map<string, RampTarget[]>();
    for (const row of rows) {
      const list = byPlatform.get(row.platform) ?? [];
      list.push({
        monthIndex: row.monthIndex,
        costPerFundedDeal: row.costPerFundedDeal === null ? null : Number(row.costPerFundedDeal),
        budget: row.budget === null ? null : Number(row.budget),
        cpa: row.cpa === null ? null : Number(row.cpa),
        // `numeric` comes back as text, like every money column beside it.
        // These two were `integer` until migration 0021 widened them for the
        // model's fractional projections — 7.5 funded deals in M1 — so they now
        // need the same coercion the columns above have always had.
        approvals: row.approvals === null ? null : Number(row.approvals),
        fundedDeals: row.fundedDeals === null ? null : Number(row.fundedDeals),
        fundedAmount: row.fundedAmount === null ? null : Number(row.fundedAmount),
      });
      byPlatform.set(row.platform, list);
    }

    return { startMonth, byPlatform };
  });
}

/* ------------------------------------------------------------------------- */
/* How far back the record goes                                              */
/* ------------------------------------------------------------------------- */

export type Ingestion = {
  /** First day of ingested paid media, or null if none was ever pulled. */
  spendFrom: string | null;
  /** First day of ingested CRM history — leads and stage events. */
  crmFrom: string | null;
};

/**
 * The earliest day each source covers.
 *
 * This decides whether a comparison is allowed to render at all, which matters
 * more here than it looks. The CRM sync reaches back to 2024 and the ad
 * platforms were first pulled in June 2026, so a trailing-90-day window
 * compared against the 90 days before it is a valid comparison for funded deals
 * and a meaningless one for spend: the baseline period had real spend that
 * nobody ingested. Dividing by it produces figures like +19,566%, which are
 * arithmetically correct and would be read as performance.
 *
 * So a delta whose baseline period predates its source renders as an explicit
 * absence with the reason, not as a number.
 */
export async function ingestionStart(session: TenantSession): Promise<Ingestion> {
  return queryTenant(session, async (tx) => {
    const tenantId = session.tenant.id;
    const [daily, stage, lead] = await Promise.all([
      tx
        .select({ day: sql<string | null>`min(${schema.dailyMetrics.date})::text` })
        .from(schema.dailyMetrics)
        .where(eq(schema.dailyMetrics.tenantId, tenantId)),
      tx
        .select({
          day: sql<string | null>`to_char(min(${schema.stageEvents.occurredOn}), 'YYYY-MM-DD')`,
        })
        .from(schema.stageEvents)
        .where(eq(schema.stageEvents.tenantId, tenantId)),
      tx
        .select({
          day: sql<string | null>`to_char(min(${schema.leads.createdOn}), 'YYYY-MM-DD')`,
        })
        .from(schema.leads)
        .where(eq(schema.leads.tenantId, tenantId)),
    ]);

    return {
      spendFrom: daily[0]?.day ?? null,
      crmFrom:
        [stage[0]?.day, lead[0]?.day].filter((d): d is string => Boolean(d)).sort()[0] ?? null,
    };
  });
}

/** True when the whole of `range` is inside what `from` covers. */
export function covers(from: string | null, range: DateRange): boolean {
  return from !== null && range.start >= from;
}

/* ------------------------------------------------------------------------- */
/* How fresh each source is                                                  */
/* ------------------------------------------------------------------------- */

export type SourceFreshness = {
  platform: string;
  label: string;
  /**
   * How the data arrives.
   *
   * `sync` is pulled on a schedule by Vercel Cron — Salesforce every ten
   * minutes, the ad platforms and organic sources hourly — so "today" on
   * every figure drawn from it means "as of the last run", and the gap between
   * the run and now is a real gap in the record. `webhook` is pushed as it
   * happens, so there is no such gap and the age of the newest record is a
   * statement about the phones rather than about the connector.
   */
  arrival: 'sync' | 'webhook';
  /**
   * The last successful run for a synced source, or the newest record received
   * for a pushed one. Null where nothing has ever arrived.
   */
  at: Date | null;
  /** True where the most recent finished run did not succeed. */
  failing: boolean;
  /**
   * For a pushed source, roughly how many records a day it used to deliver,
   * measured over the fortnight before its newest one. Null for a synced
   * source, and for a pushed one that has never delivered anything.
   *
   * It is what turns "nothing recently" into a judgement. A desk that averaged
   * three hundred calls a day and has sent none for four days is not having a
   * quiet week — nothing is arriving.
   */
  typicalPerDay: number | null;
};

/**
 * How current each source on the executive screen is.
 *
 * Every figure on that screen is as of its source's last run, and hourly
 * syncing makes that a real distinction rather than a pedantic one: a range
 * ending today is a partial day everywhere, and the part that is missing is
 * however long ago the connector last ran. Left unstated, a client reads a
 * morning figure as the day's figure and a flat afternoon as a flat afternoon.
 *
 * Two sources are treated differently on purpose:
 *
 *   * **Calls arrive by webhook**, so there is no run to be behind. What is
 *     reported is the newest call received, and it is never stale in the sense
 *     the other rows use — a quiet hour on the phones is a quiet hour, not a
 *     broken connector, and colouring it amber would say the opposite.
 *   * **Only the sources this screen draws from are listed.** Paid media that
 *     has reported spend, the CRM, and calls. GA4 and Search Console are
 *     connected and healthy and back no figure here, so their sync ages are not
 *     facts about anything on this page — a row of five timestamps where three
 *     are irrelevant is a strip nobody reads, and the connections screen is
 *     where an idle connector belongs.
 */
export async function sourceFreshness(session: TenantSession): Promise<SourceFreshness[]> {
  return queryTenant(session, async (tx) => {
    const tenantId = session.tenant.id;

    const [connections, runs, [newestCall], spendPlatforms] = await Promise.all([
      tx
        .select({ platform: schema.connections.platform, status: schema.connections.status })
        .from(schema.connections)
        .where(eq(schema.connections.tenantId, tenantId))
        .orderBy(asc(schema.connections.platform)),

      // Two facts per platform, and they are not the same one: the last run
      // that *succeeded* is what the figures are as of, and the last run that
      // *finished* is what says whether the connector is currently broken. A
      // source whose last success was an hour ago and whose last run failed ten
      // minutes ago is both current and failing, and reporting only one of
      // those would mislead in one direction or the other.
      tx
        .select({
          platform: schema.syncRuns.platform,
          lastSuccess: sql<string | Date | null>`max(${schema.syncRuns.finishedAt}) filter (where ${schema.syncRuns.status} = 'succeeded')`,
          lastFinishStatus: sql<string | null>`(array_agg(${schema.syncRuns.status} order by ${schema.syncRuns.finishedAt} desc))[1]`,
        })
        .from(schema.syncRuns)
        .where(and(eq(schema.syncRuns.tenantId, tenantId), isNotNull(schema.syncRuns.finishedAt)))
        .groupBy(schema.syncRuns.platform),

      /*
       * The newest call, and the cadence it arrived at before that.
       *
       * `occurred_at` rather than `updated_at`: the webhook's claim is that a
       * call is here as soon as it ends, and when it happened is what tests
       * that claim. The daily rate over the fortnight before the newest record
       * is what says whether silence since is a quiet desk or a dead pipe.
       */
      tx
        .select({
          at: sql<string | Date | null>`max(${schema.calls.occurredAt})`,
          perDay: sql<string | null>`(
            select round(count(*) / 14.0, 1)
            from ${schema.calls} c
            where c.tenant_id = ${tenantId}
              and c.occurred_at > (
                select max(occurred_at) from ${schema.calls} where tenant_id = ${tenantId}
              ) - interval '14 days'
          )`,
        })
        .from(schema.calls)
        .where(eq(schema.calls.tenantId, tenantId)),

      // Which paid-media platforms have actually written a figure. A connector
      // that is healthy and has reported nothing is not behind on anything this
      // screen shows.
      tx
        .selectDistinct({ platform: schema.dailyMetrics.platform })
        .from(schema.dailyMetrics)
        .where(eq(schema.dailyMetrics.tenantId, tenantId)),
    ]);

    const byPlatform = new Map(runs.map((r) => [r.platform, r]));

    /*
     * An aggregate comes back as text, not as a Date.
     *
     * A plain `timestamptz` column is parsed by the driver; `max()` over one is
     * not, and the difference is invisible until a `.getTime()` two files away
     * throws on a server render. Coerced here, where the shape is declared,
     * rather than trusted at the call site.
     */
    const toDate = (value: string | Date | null | undefined): Date | null => {
      if (!value) return null;
      const date = value instanceof Date ? value : new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    };

    // The sources behind the figures on the executive screen, and nothing else.
    const onScreen = new Set<string>([
      'salesforce',
      'call_tracking',
      ...spendPlatforms.map((row) => row.platform),
    ]);

    return connections
      .filter((c) => c.status !== 'not_configured' && onScreen.has(c.platform))
      .map((connection): SourceFreshness => {
        const webhook = connection.platform === 'call_tracking';
        const run = byPlatform.get(connection.platform);
        return {
          platform: connection.platform,
          label: platformLabel(connection.platform),
          arrival: webhook ? 'webhook' : 'sync',
          at: toDate(webhook ? newestCall?.at : run?.lastSuccess),
          typicalPerDay:
            webhook && newestCall?.perDay != null ? Number(newestCall.perDay) : null,
          // A webhook source has no run to fail. Its connection status still
          // carries a fault where one is known, and that is the connections
          // screen's subject rather than this strip's.
          failing: !webhook && run?.lastFinishStatus != null && run.lastFinishStatus !== 'succeeded',
        };
      });
  });
}

/* ------------------------------------------------------------------------- */
/* Campaigns that are configured but not running                             */
/* ------------------------------------------------------------------------- */

export type PausedCampaigns = {
  platform: string;
  label: string;
  /** Campaigns the platform reports as paused. */
  paused: number;
  /** Every campaign on the account, running or not. */
  total: number;
  /**
   * Paused campaigns that spent inside the window asked about.
   *
   * The finding, as opposed to the count. An account accumulates paused
   * campaigns the way a drawer accumulates cables — thirty-three of Spartan's
   * thirty-nine Google campaigns are paused and most have never run under this
   * engagement. A campaign that *was* spending and has stopped is a different
   * fact, and it is the one worth a line on a briefing.
   */
  pausedWithRecentSpend: number;
  /** Spend those campaigns took before they stopped. */
  recentSpend: number;
};

/**
 * Paused campaigns per platform, and how many of them ran recently.
 *
 * `status` is the platform's own word, stored verbatim — Google says `PAUSED`
 * and `REMOVED`, Meta says `PAUSED` — so the match is case-insensitive on
 * `paused` alone. `REMOVED` is deliberately not counted: a deleted campaign is
 * not a configuration somebody left behind, it is one they cleaned up.
 */
export async function pausedCampaigns(
  session: TenantSession,
  since: string,
): Promise<PausedCampaigns[]> {
  return queryTenant(session, async (tx) => {
    const rows = await tx
      .select({
        platform: schema.campaigns.platform,
        total: sql<number>`count(*)::int`,
        paused: sql<number>`count(*) filter (where upper(${schema.campaigns.status}) = 'PAUSED')::int`,
        pausedWithRecentSpend: sql<number>`count(*) filter (
          where upper(${schema.campaigns.status}) = 'PAUSED' and coalesce(s.spend, 0) > 0
        )::int`,
        recentSpend: sql<string>`coalesce(sum(s.spend) filter (
          where upper(${schema.campaigns.status}) = 'PAUSED'
        ), 0)`,
      })
      .from(schema.campaigns)
      .leftJoin(
        tx
          .select({
            campaignId: schema.dailyMetrics.campaignId,
            spend: sql<string>`sum(${schema.dailyMetrics.spend})`.as('spend'),
          })
          .from(schema.dailyMetrics)
          .where(
            and(
              eq(schema.dailyMetrics.tenantId, session.tenant.id),
              gte(schema.dailyMetrics.date, since),
            ),
          )
          .groupBy(schema.dailyMetrics.campaignId)
          .as('s'),
        sql`s.campaign_id = ${schema.campaigns.id}`,
      )
      .where(eq(schema.campaigns.tenantId, session.tenant.id))
      .groupBy(schema.campaigns.platform)
      .orderBy(asc(schema.campaigns.platform));

    return rows.map((row) => ({
      platform: row.platform,
      label: platformLabel(row.platform),
      paused: Number(row.paused),
      total: Number(row.total),
      pausedWithRecentSpend: Number(row.pausedWithRecentSpend),
      recentSpend: Number(row.recentSpend),
    }));
  });
}

/* ------------------------------------------------------------------------- */
/* The frozen baseline                                                       */
/* ------------------------------------------------------------------------- */

export type FrozenMonth = MonthActual & { frozenAt: Date; version: number };

/**
 * Every frozen baseline month's current version, keyed
 * `platform|YYYY-MM|metric`.
 *
 * Current is the highest version: a correction is inserted, never edited
 * (migration 0032), so the history stays in the table and this reads the top
 * of it. The ramp shows these in place of recomputing the month.
 */
export async function frozenBaseline(session: TenantSession): Promise<Map<string, FrozenMonth>> {
  const rows = await queryTenant(session, (tx) =>
    tx
      .select()
      .from(schema.baselineSnapshots)
      .where(eq(schema.baselineSnapshots.tenantId, session.tenant.id)),
  );
  const out = new Map<string, FrozenMonth>();
  const num = (v: string | null) => (v === null ? null : Number(v));
  for (const row of rows) {
    const key = `${row.platform}|${String(row.month).slice(0, 7)}|${row.metric}`;
    const existing = out.get(key);
    if (existing && existing.version >= row.version) continue;
    const value = num(row.value);
    const attributed = num(row.attributed);
    out.set(key, {
      value,
      reason: row.notMeasuredReason,
      cost:
        value !== null && attributed !== null && row.channelSpend !== null
          ? {
              channelSpend: Number(row.channelSpend),
              attributedDeals: attributed,
              value,
              unattributedDeals: num(row.unattributed) ?? 0,
              dealsAttributedElsewhere: num(row.attributedElsewhere) ?? 0,
              plausibleRange: { low: num(row.rangeLow), high: num(row.rangeHigh) },
            }
          : undefined,
      frozenAt: row.frozenAt,
      version: row.version,
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Reconciliation                                                            */
/* ------------------------------------------------------------------------- */

export type ReconciliationRow = {
  source: string;
  metric: string;
  windowStart: string;
  windowEnd: string;
  ours: number | null;
  theirs: number | null;
  status: 'match' | 'drift' | 'explained' | 'error';
  detail: string | null;
  checkedAt: Date;
};

/**
 * The latest reconciliation checks, per source.
 *
 * Written daily by the reconciliation job (`reconciliation_checks`); read by
 * the Connections screen, which names each drift rather than colouring a
 * tile — a source that disagrees with our figures is a fact to state with its
 * days, not a status light.
 */
export async function reconciliationBySource(session: TenantSession): Promise<Map<string, ReconciliationRow[]>> {
  // Only the windows the daily job checks now — last month and this month —
  // not every window ever checked: a by-hand check of June stays in the table
  // as evidence, but it is not the state of the connection today.
  const today = tenantDay(new Date(), session.tenant.timezone);
  const lastMonthStart = `${previousMonthKey(today.slice(0, 7))}-01`;
  const rows = await queryTenant(session, (tx) =>
    tx
      .select()
      .from(schema.reconciliationChecks)
      .where(
        and(
          eq(schema.reconciliationChecks.tenantId, session.tenant.id),
          gte(schema.reconciliationChecks.windowStart, lastMonthStart),
        ),
      )
      .orderBy(asc(schema.reconciliationChecks.windowStart)),
  );
  const out = new Map<string, ReconciliationRow[]>();
  for (const r of rows) {
    const list = out.get(r.source) ?? out.set(r.source, []).get(r.source)!;
    list.push({
      source: r.source,
      metric: r.metric,
      windowStart: String(r.windowStart),
      windowEnd: String(r.windowEnd),
      ours: r.ours === null ? null : Number(r.ours),
      theirs: r.theirs === null ? null : Number(r.theirs),
      status: r.status,
      detail: r.detail,
      checkedAt: r.checkedAt,
    });
  }
  return out;
}
