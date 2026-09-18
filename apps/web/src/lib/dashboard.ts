import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { schema } from '@zeeraa/db';
import {
  addDays,
  bucketLabel,
  evenBucketsIn,
  monthBucketsIn,
  type AttributionModel,
  type DateRange,
  type DayBucket,
  type ImprovementDirection,
} from '@zeeraa/core';
import { queryTenant, type TenantSession } from '@/lib/tenant';
import { platformLabel, type StageCounts } from '@/lib/reporting';

/**
 * The queries behind the dashboard furniture that spec v2 added: a mini chart
 * on every KPI card, a delta against the previous period on every figure, one
 * data-quality card per screen, and a delivery view with real progress bars.
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
};

export async function loadMetrics(session: TenantSession): Promise<Metrics> {
  const rows = await queryTenant(session, (tx) =>
    tx
      .select()
      .from(schema.tenantMetrics)
      .where(eq(schema.tenantMetrics.tenantId, session.tenant.id))
      .orderBy(asc(schema.tenantMetrics.key)),
  );

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

  return {
    byKey,
    northStar: configs.find((c) => c.isNorthStar) ?? null,
    direction: (key) => byKey.get(key)?.improvementDirection ?? null,
    target: (key) => {
      const metric = byKey.get(key);
      if (!metric || metric.needsReconciliation) return null;
      return metric.target;
    },
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
  /** Funded amount on the value-stage deals in this bucket, every source. */
  valueVolume: number;
};

export type Granularity = 'month' | 'week';

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
    granularity === 'month' ? monthBucketsIn(range) : evenBucketsIn(range, 7);

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
          day: sql<string>`to_char(${schema.stageEvents.occurredAt}, 'YYYY-MM-DD')`,
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
            gte(schema.stageEvents.occurredAt, new Date(`${range.start}T00:00:00.000Z`)),
            lte(schema.stageEvents.occurredAt, new Date(`${range.end}T23:59:59.999Z`)),
          ),
        ),

      tx
        .select({
          day: sql<string>`to_char(${schema.leads.createdAt}, 'YYYY-MM-DD')`,
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
        .groupBy(sql`1`, schema.leads.clickIdType),

      tx
        .select({ day: sql<string | null>`min(${schema.dailyMetrics.date})::text` })
        .from(schema.dailyMetrics)
        .where(eq(schema.dailyMetrics.tenantId, tenantId)),

      tx
        .select({
          day: sql<string | null>`to_char(min(${schema.stageEvents.occurredAt}), 'YYYY-MM-DD')`,
        })
        .from(schema.stageEvents)
        .where(eq(schema.stageEvents.tenantId, tenantId)),

      tx
        .select({
          day: sql<string | null>`to_char(min(${schema.leads.createdAt}), 'YYYY-MM-DD')`,
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
    // is absent from the record rather than zero in it.
    const spendFrom = firstDaily[0]?.day ?? null;
    const crmFrom =
      [firstStage[0]?.day, firstLead[0]?.day].filter((d): d is string => Boolean(d)).sort()[0] ??
      null;

    const leadStageKeys = stages.filter((s) => s.source === 'leads').map((s) => s.key);
    const settledBefore = addDays(range.end, -6);

    return spans.map((span) => {
      const bucket: WindowBucket = {
        key: span.key,
        label: bucketLabel(span, granularity === 'month' ? 'month' : 'day'),
        start: span.start,
        end: span.end,
        spendIngested: spendFrom !== null && span.end >= spendFrom,
        crmIngested: crmFrom !== null && span.end >= crmFrom,
        provisional: span.end >= settledBefore,
        spend: 0,
        clicks: 0,
        impressions: 0,
        spendByPlatform: {},
        stages: {},
        stagesByPlatform: {},
        unattributedStages: {},
        valueVolume: 0,
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

      for (const row of stageRows) {
        if (row.day < span.start || row.day > span.end) continue;
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
          bucket.valueVolume += amounts.get(row.opportunityExternalId) ?? 0;
        }
      }

      // Lead-grain stages are counted from `leads`, because a lead that never
      // became an opportunity has no opportunity to attribute through.
      for (const row of leadRows) {
        if (row.day < span.start || row.day > span.end) continue;
        const count = Number(row.count);
        for (const stageKey of leadStageKeys) {
          bucket.stages[stageKey] = (bucket.stages[stageKey] ?? 0) + count;
          if (row.clickIdType) {
            const counts = (bucket.stagesByPlatform[row.clickIdType] ??= {});
            counts[stageKey] = (counts[stageKey] ?? 0) + count;
          } else {
            bucket.unattributedStages[stageKey] =
              (bucket.unattributedStages[stageKey] ?? 0) + count;
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
  status: 'not_measured' | 'waiting_on_client' | 'degraded' | 'unreconciled' | 'not_configured';
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
  not_configured: 4,
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
  const [blocked, connections, metrics] = await Promise.all([
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
  ]);

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
      .map(
        (row): DataQualityItem => ({
          key: `connection:${row.platform}`,
          name: platformLabel(row.platform),
          status: row.status === 'degraded' ? 'degraded' : 'waiting_on_client',
          summary: firstSentence(row.blockedReason ?? row.lastError ?? 'Connection unavailable.'),
          detail: row.blockedReason ?? row.lastError ?? '',
          since: row.blockedSince ?? null,
        }),
      ),
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

  return items.sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
  );
}

/**
 * The first sentence of a reason, for the one-line row.
 *
 * Splits on a full stop followed by whitespace, not on any full stop: the
 * reasons in this product are full of Salesforce API names, and a naive split
 * turns "Opportunity.csbs__Decline_Reason__c does not exist in the org" into
 * "Opportunity." Falls back to the whole text when there is no break.
 */
function firstSentence(text: string): string {
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
      tx
        .select({
          platform: schema.syncRuns.platform,
          finishedAt: schema.syncRuns.finishedAt,
          status: schema.syncRuns.status,
          rowsWritten: schema.syncRuns.rowsWritten,
          rank: sql<number>`row_number() over (
            partition by ${schema.syncRuns.platform}
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

    const latest = new Map(
      runs.filter((r) => Number(r.rank) === 1).map((r) => [r.platform, r]),
    );

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
        detail: row.blockedReason ?? row.lastError ?? null,
        since: row.blockedSince ?? null,
      };
    });
  });
}

/* ------------------------------------------------------------------------- */
/* Delivery                                                                  */
/* ------------------------------------------------------------------------- */

export type CommitmentRow = {
  key: string;
  label: string;
  committed: number;
  committedMax: number | null;
  unit: string;
  period: 'monthly' | 'quarterly';
  requiresClientApproval: boolean;
  /**
   * Null where no record has been written for the period — which is not zero
   * delivered. A commitment nobody has recorded against and a commitment
   * delivered zero times are different claims, and only one of them is a
   * failure to deliver.
   */
  delivered: number | null;
  /** How the delivered count was established, where there is one. */
  source: 'manual' | 'derived_from_assets' | null;
  /** Assets submitted against this commitment and still awaiting approval. */
  awaitingApproval: number;
};

export type SlaRow = {
  type: string;
  label: string;
  commitment: string;
  /** Null where no event has been recorded: no compliance rate exists yet. */
  compliance: number | null;
  events: number;
  met: number;
};

export type DeliveryStatus = {
  periodStart: string;
  periodLabel: string;
  commitments: CommitmentRow[];
  slas: SlaRow[];
  /** Assets submitted and awaiting a client decision, across every commitment. */
  approvalsPending: number;
  /** Assets that exist at all. Zero here is a measurement; the table is empty. */
  assetsTotal: number;
};

export async function deliveryStatus(
  session: TenantSession,
  today: string,
): Promise<DeliveryStatus> {
  const periodStart = `${today.slice(0, 7)}-01`;
  const quarterMonth = Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1;
  const quarterStart = `${today.slice(0, 4)}-${String(quarterMonth).padStart(2, '0')}-01`;

  return queryTenant(session, async (tx) => {
    const tenantId = session.tenant.id;

    const [commitments, records, slas, slaEvents, assets] = await Promise.all([
      tx
        .select()
        .from(schema.deliverableCommitments)
        .where(eq(schema.deliverableCommitments.tenantId, tenantId))
        .orderBy(asc(schema.deliverableCommitments.position)),

      tx
        .select()
        .from(schema.deliverableRecords)
        .where(
          and(
            eq(schema.deliverableRecords.tenantId, tenantId),
            inArray(schema.deliverableRecords.periodStart, [periodStart, quarterStart]),
          ),
        ),

      tx
        .select()
        .from(schema.slaCommitments)
        .where(eq(schema.slaCommitments.tenantId, tenantId))
        .orderBy(asc(schema.slaCommitments.type)),

      tx
        .select({
          type: schema.slaEvents.type,
          responseMinutes: schema.slaEvents.responseMinutes,
        })
        .from(schema.slaEvents)
        .where(
          and(
            eq(schema.slaEvents.tenantId, tenantId),
            gte(schema.slaEvents.occurredAt, new Date(`${periodStart}T00:00:00.000Z`)),
          ),
        ),

      tx
        .select({
          commitmentKey: schema.assets.commitmentKey,
          status: schema.assets.status,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.assets)
        .where(eq(schema.assets.tenantId, tenantId))
        .groupBy(schema.assets.commitmentKey, schema.assets.status),
    ]);

    const pendingByCommitment = new Map<string, number>();
    let approvalsPending = 0;
    let assetsTotal = 0;
    for (const row of assets) {
      assetsTotal += Number(row.count);
      if (row.status === 'submitted') {
        approvalsPending += Number(row.count);
        if (row.commitmentKey) {
          pendingByCommitment.set(
            row.commitmentKey,
            (pendingByCommitment.get(row.commitmentKey) ?? 0) + Number(row.count),
          );
        }
      }
    }

    const commitmentRows = commitments.map((row): CommitmentRow => {
      const start = row.period === 'quarterly' ? quarterStart : periodStart;
      const mine = records.filter(
        (r) => r.commitmentKey === row.key && r.periodStart === start,
      );
      const delivered = mine.length
        ? mine.reduce((sum, r) => sum + Number(r.deliveredQuantity), 0)
        : null;

      return {
        key: row.key,
        label: row.label,
        committed: Number(row.committedQuantity),
        committedMax: row.committedQuantityMax === null ? null : Number(row.committedQuantityMax),
        unit: row.unit,
        period: row.period,
        requiresClientApproval: row.requiresClientApproval,
        delivered,
        source: mine[0]?.source ?? null,
        awaitingApproval: pendingByCommitment.get(row.key) ?? 0,
      };
    });

    const slaRows = slas.map((row): SlaRow => {
      const mine = slaEvents.filter((e) => e.type === row.type);
      // A cadence commitment is met by the event happening at all; a response
      // time is met by landing inside the target.
      const met = mine.filter((e) =>
        row.targetMinutes === null
          ? true
          : e.responseMinutes !== null && e.responseMinutes <= row.targetMinutes,
      ).length;

      return {
        type: row.type,
        label: row.label,
        commitment:
          row.targetMinutes !== null
            ? `Within ${row.targetMinutes} minutes`
            : (row.cadence ?? 'As agreed'),
        compliance: mine.length === 0 ? null : met / mine.length,
        events: mine.length,
        met,
      };
    });

    return {
      periodStart,
      periodLabel: new Date(`${periodStart}T00:00:00Z`).toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }),
      commitments: commitmentRows,
      slas: slaRows,
      approvalsPending,
      assetsTotal,
    };
  });
}

/* ------------------------------------------------------------------------- */
/* Workspace                                                                 */
/* ------------------------------------------------------------------------- */

export type WorkspaceCard = {
  id: string;
  title: string;
  type: string;
  typeLabel: string;
  status: string;
  commitmentKey: string | null;
  commitmentLabel: string | null;
  assigneeName: string | null;
  comments: number;
  version: number;
  updatedAt: Date;
};

export type WorkspaceBoard = {
  types: { key: string; label: string }[];
  columns: { status: string; label: string; cards: WorkspaceCard[] }[];
  total: number;
};

/** The board statuses, from the `asset_status` enum, in review order. */
const BOARD_COLUMNS: { status: string; label: string }[] = [
  { status: 'draft', label: 'Draft' },
  { status: 'submitted', label: 'Awaiting approval' },
  { status: 'changes_requested', label: 'Changes requested' },
  { status: 'approved', label: 'Approved' },
  { status: 'published', label: 'Published' },
];

export async function workspaceBoard(session: TenantSession): Promise<WorkspaceBoard> {
  return queryTenant(session, async (tx) => {
    const tenantId = session.tenant.id;

    const [types, commitments, rows, commentCounts] = await Promise.all([
      tx
        .select({ key: schema.assetTypes.key, label: schema.assetTypes.label })
        .from(schema.assetTypes)
        .where(eq(schema.assetTypes.tenantId, tenantId))
        .orderBy(asc(schema.assetTypes.position)),

      tx
        .select({
          key: schema.deliverableCommitments.key,
          label: schema.deliverableCommitments.label,
        })
        .from(schema.deliverableCommitments)
        .where(eq(schema.deliverableCommitments.tenantId, tenantId)),

      tx
        .select({
          id: schema.assets.id,
          title: schema.assets.title,
          type: schema.assets.type,
          status: schema.assets.status,
          commitmentKey: schema.assets.commitmentKey,
          version: schema.assets.version,
          uploadedAt: schema.assets.uploadedAt,
          assigneeName: schema.users.name,
        })
        .from(schema.assets)
        .leftJoin(schema.users, eq(schema.users.id, schema.assets.uploadedByUserId))
        .where(eq(schema.assets.tenantId, tenantId))
        .orderBy(desc(schema.assets.uploadedAt)),

      tx
        .select({
          assetId: schema.assetComments.assetId,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.assetComments)
        .where(eq(schema.assetComments.tenantId, tenantId))
        .groupBy(schema.assetComments.assetId),
    ]);

    const typeLabels = new Map(types.map((t) => [t.key, t.label]));
    const commitmentLabels = new Map(commitments.map((c) => [c.key, c.label]));
    const comments = new Map(commentCounts.map((c) => [c.assetId, Number(c.count)]));

    const cards = rows.map(
      (row): WorkspaceCard => ({
        id: row.id,
        title: row.title,
        type: row.type,
        typeLabel: typeLabels.get(row.type) ?? row.type,
        status: row.status,
        commitmentKey: row.commitmentKey,
        commitmentLabel: row.commitmentKey
          ? (commitmentLabels.get(row.commitmentKey) ?? row.commitmentKey)
          : null,
        assigneeName: row.assigneeName,
        comments: comments.get(row.id) ?? 0,
        version: row.version,
        updatedAt: row.uploadedAt,
      }),
    );

    return {
      types,
      columns: BOARD_COLUMNS.map((column) => ({
        ...column,
        cards: cards.filter((c) => c.status === column.status),
      })),
      total: cards.length,
    };
  });
}

/* ------------------------------------------------------------------------- */
/* Notifications                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Unread notifications for this viewer in this tenant, for the bell.
 *
 * Scoped to the tenant as well as to the user: a Zeeraa admin with four clients
 * must not see another client's count while looking at this one, and the
 * `notifications` policy enforces the tenant half regardless of this filter.
 */
export async function unreadNotifications(session: TenantSession): Promise<number> {
  const [row] = await queryTenant(session, (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.tenantId, session.tenant.id),
          eq(schema.notifications.userId, session.viewer.userId),
          sql`${schema.notifications.readAt} is null`,
        ),
      ),
  );
  return Number(row?.count ?? 0);
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
          day: sql<string | null>`to_char(min(${schema.stageEvents.occurredAt}), 'YYYY-MM-DD')`,
        })
        .from(schema.stageEvents)
        .where(eq(schema.stageEvents.tenantId, tenantId)),
      tx
        .select({
          day: sql<string | null>`to_char(min(${schema.leads.createdAt}), 'YYYY-MM-DD')`,
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
