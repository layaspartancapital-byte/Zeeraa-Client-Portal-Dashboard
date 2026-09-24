import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { channelFigures, stageMetric } from './channel-figures';
import { channelMonth, getMaintenanceDb, schema, withJobTenant, withMaintenance, type Database } from '@zeeraa/db';
import {
  addDays,
  channelMonthActuals,
  eachDay,
  isMonthKey,
  monthRange,
  platformLabel,
  RAMP_METRICS,
  rangeCoverage,
  tenantDay,
  type MonthKey,
} from '@zeeraa/core';
import { lastCompletedWatermark } from './sync-runs';

/**
 * Freezing the audited baseline (migration 0032).
 *
 * The ramp's months before M1 are the argument the engagement is judged
 * against, so once audited they must not move: a restatement, a deleted lead,
 * a re-attributed deal would otherwise change the baseline silently, weeks
 * after everybody agreed it. A frozen month is written once, per metric, from
 * exactly the figures the ramp shows (`channelMonthActuals`), with who froze
 * it and why; the table refuses edits for every role.
 */
export type FreezeOutcome = {
  month: MonthKey;
  status: 'frozen' | 'already_frozen' | 'deferred';
  detail: string;
};

type FreezeOptions = {
  tenantId: string;
  months: MonthKey[];
  /** Who froze it: a person's name, or `daily-job`. */
  by: string;
  reason: string;
  now?: Date;
  /** Write nothing; report what would be frozen. */
  dryRun?: boolean;
};

export async function freezeBaselineMonths(options: FreezeOptions): Promise<FreezeOutcome[]> {
  const now = options.now ?? new Date();
  const outcomes: FreezeOutcome[] = [];

  await withJobTenant(options.tenantId, async (tx) => {
    const context = await freezeContext(tx, options.tenantId, now);
    for (const month of options.months) {
      if (!isMonthKey(month)) throw new Error(`Not a month: ${month}`);
      if (month >= context.today.slice(0, 7)) {
        outcomes.push({ month, status: 'deferred', detail: 'A month in progress cannot be frozen.' });
        continue;
      }
      const existing = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.baselineSnapshots)
        .where(
          and(
            eq(schema.baselineSnapshots.tenantId, options.tenantId),
            eq(schema.baselineSnapshots.platform, context.platform),
            eq(schema.baselineSnapshots.month, `${month}-01`),
            // The ramp's own metrics only: a month can carry channel figures
            // (`freezeChannelFigures`) without its ramp being frozen.
            inArray(schema.baselineSnapshots.metric, [...RAMP_METRICS]),
          ),
        );
      if (Number(existing[0]?.n ?? 0) > 0) {
        outcomes.push({ month, status: 'already_frozen', detail: 'Frozen already; a correction is a new version.' });
        continue;
      }

      const figures = await monthFigures(tx, options.tenantId, context, month);
      if (!options.dryRun) {
        await tx.insert(schema.baselineSnapshots).values(
          RAMP_METRICS.map((metric) => {
            const f = figures[metric];
            return {
              tenantId: options.tenantId,
              month: `${month}-01`,
              platform: context.platform,
              metric,
              version: 1,
              value: f.value === null ? null : String(f.value),
              notMeasuredReason: f.value === null ? f.reason : null,
              channelSpend: f.cost ? String(f.cost.channelSpend) : null,
              attributed: f.cost ? String(f.cost.attributedDeals) : null,
              unattributed: f.cost ? String(f.cost.unattributedDeals) : null,
              attributedElsewhere: f.cost ? String(f.cost.dealsAttributedElsewhere) : null,
              rangeLow: f.cost?.plausibleRange.low == null ? null : String(f.cost.plausibleRange.low),
              rangeHigh: f.cost?.plausibleRange.high == null ? null : String(f.cost.plausibleRange.high),
              frozenAt: now,
              frozenBy: options.by,
              reason: options.reason,
            };
          }),
        );
      }
      const summary = RAMP_METRICS.map((m) => `${m}=${figures[m].value === null ? 'not measured' : Math.round(figures[m].value! * 100) / 100}`).join(', ');
      outcomes.push({ month, status: 'frozen', detail: `${options.dryRun ? '(dry run) ' : ''}${summary}` });
    }
  });
  return outcomes;
}

/**
 * The months due to freeze on their own: listed in the `baseline_freeze`
 * config row, and at least `freezeAfterDays` past their end — by then spend and
 * deal counts are final (the client's decision for September 2026: early
 * October). Only frozen when the day's reconciliation shows no unexplained
 * drift for the month; otherwise deferred, with the drift named.
 */
export async function autoFreeze(tenantId: string, now = new Date()): Promise<FreezeOutcome[]> {
  const [config, timezone] = await withJobTenant(tenantId, async (tx) => [
    (
      await tx
        .select({ value: schema.tenantConfig.value })
        .from(schema.tenantConfig)
        .where(and(eq(schema.tenantConfig.tenantId, tenantId), eq(schema.tenantConfig.key, 'baseline_freeze')))
    )[0]?.value as { months?: string[]; freezeAfterDays?: number } | undefined,
    (await tx.select({ tz: schema.tenants.timezone }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)))[0]?.tz ?? 'UTC',
  ] as const);
  if (!config?.months?.length) return [];

  const today = tenantDay(now, timezone);
  const after = config.freezeAfterDays ?? 5;
  const due = config.months.filter((m) => isMonthKey(m) && addDays(monthRange(m).end, after) <= today);
  const outcomes: FreezeOutcome[] = [];
  for (const month of due) {
    const window = monthRange(month);
    const drift = await withJobTenant(tenantId, (tx) =>
      tx
        .select({ source: schema.reconciliationChecks.source, metric: schema.reconciliationChecks.metric, detail: schema.reconciliationChecks.detail })
        .from(schema.reconciliationChecks)
        .where(
          and(
            eq(schema.reconciliationChecks.tenantId, tenantId),
            eq(schema.reconciliationChecks.windowStart, window.start),
            eq(schema.reconciliationChecks.windowEnd, window.end),
            sql`${schema.reconciliationChecks.status} in ('drift', 'error')`,
            // The figures the baseline is made of: spend and the CRM's stages.
            sql`(${schema.reconciliationChecks.source} = 'salesforce' or ${schema.reconciliationChecks.metric} = 'spend')`,
          ),
        ),
    );
    if (drift.length > 0) {
      outcomes.push({
        month,
        status: 'deferred',
        detail: `Not frozen: the reconciliation shows drift — ${drift.map((d) => `${d.source} ${d.metric}${d.detail ? ` (${d.detail})` : ''}`).join('; ')}.`,
      });
      continue;
    }
    outcomes.push(
      ...(await freezeBaselineMonths({
        tenantId,
        months: [month],
        by: 'daily-job',
        reason: `Frozen automatically ${after} days after the month ended, with the reconciliation clean.`,
        now,
      })),
    );
  }
  return outcomes;
}

export type FreezeContext = {
  platform: string;
  today: string;
  timezone: string;
  valueStage: string | null;
  renderFloor: number;
  crmThrough: string | null;
};

export async function freezeContext(tx: Database, tenantId: string, now: Date): Promise<FreezeContext> {
  const [tenant] = await tx.select({ tz: schema.tenants.timezone }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  const timezone = tenant?.tz ?? 'UTC';
  const [target] = await tx
    .select({ platform: schema.engagementTargets.platform })
    .from(schema.engagementTargets)
    .where(eq(schema.engagementTargets.tenantId, tenantId))
    .orderBy(asc(schema.engagementTargets.platform))
    .limit(1);
  if (!target) throw new Error('No engagement targets: there is no ramp channel to freeze a baseline for.');
  const [value] = await tx
    .select({ key: schema.funnelStages.key })
    .from(schema.funnelStages)
    .where(and(eq(schema.funnelStages.tenantId, tenantId), eq(schema.funnelStages.countsValue, true)))
    .limit(1);
  const [floors] = await tx
    .select({ value: schema.tenantConfig.value })
    .from(schema.tenantConfig)
    .where(and(eq(schema.tenantConfig.tenantId, tenantId), eq(schema.tenantConfig.key, 'min_rate_denominator')));
  const watermark = await lastCompletedWatermark(tx, tenantId);
  return {
    platform: target.platform,
    today: tenantDay(now, timezone),
    timezone,
    valueStage: value?.key ?? null,
    renderFloor: Number((floors?.value as { render?: number } | undefined)?.render ?? 3),
    crmThrough: watermark ? tenantDay(watermark, timezone) : null,
  };
}

/** The six figures for one month, as the ramp computes them. */
export async function monthFigures(tx: Database, tenantId: string, context: FreezeContext, month: MonthKey) {
  const cm = await channelMonth(tx, {
    tenantId,
    platform: context.platform,
    month,
    stages: ['uw_approved', ...(context.valueStage ? [context.valueStage] : [])],
    valueStage: context.valueStage,
  });
  const whole = monthRange(month);
  const clipped = { start: whole.start, end: whole.end < context.today ? whole.end : context.today };
  const beforeRecord =
    cm.firstRead && clipped.start < cm.firstRead
      ? eachDay({ start: clipped.start, end: clipped.end < cm.firstRead ? clipped.end : addDays(cm.firstRead, -1) })
      : [];
  const read = new Set(cm.readDays);
  const holes = cm.firstRead && cm.lastRead
    ? eachDay({ start: cm.firstRead > clipped.start ? cm.firstRead : clipped.start, end: cm.lastRead < clipped.end ? cm.lastRead : clipped.end })
        .filter((d) => !read.has(d))
    : [];
  return channelMonthActuals(
    {
      spend: cm.spend,
      stages: cm.stages,
      ownVolume: cm.ownVolume,
      spendCoverage: rangeCoverage(clipped, cm.lastRead, [...beforeRecord, ...holes]),
      crmRead: context.crmThrough !== null && context.crmThrough >= whole.start,
    },
    {
      month,
      currentMonth: context.today.slice(0, 7),
      channel: platformLabel(context.platform),
      valueStage: context.valueStage,
      approvalStage: 'uw_approved',
      renderFloor: context.renderFloor,
    },
  );
}

/** For the daily job: every tenant that has engagement targets. */
export async function tenantsWithRamp(): Promise<string[]> {
  const rows = await withMaintenance(getMaintenanceDb(), (tx) =>
    tx.selectDistinct({ tenantId: schema.engagementTargets.tenantId }).from(schema.engagementTargets),
  );
  return rows.map((r) => r.tenantId);
}

/**
 * Freezes the key figures the ramp's six do not cover (24 September 2026):
 * every funnel stage per channel, and spend, funded volume, CPA and cost per
 * funded deal for each paid channel other than the ramp's — from
 * `channelFigures`. The ramp channel's approvals, funded deals, spend, volume,
 * CPA and cost per funded deal are its ramp metrics already, so they are not
 * written twice under a second name.
 *
 * Append-only like the ramp freeze: a figure already frozen for the month is
 * left alone, and a correction is the next version with a reason.
 */
export async function freezeChannelFigures(options: FreezeOptions): Promise<FreezeOutcome[]> {
  const now = options.now ?? new Date();
  const outcomes: FreezeOutcome[] = [];
  await withJobTenant(options.tenantId, async (tx) => {
    const context = await freezeContext(tx, options.tenantId, now);
    const rampCovered = new Set([
      'spend',
      'funded_volume',
      'cpa',
      'cost_per_funded',
      stageMetric('uw_approved'),
      ...(context.valueStage ? [stageMetric(context.valueStage)] : []),
    ]);
    for (const month of options.months) {
      if (!isMonthKey(month)) throw new Error(`Not a month: ${month}`);
      if (month >= context.today.slice(0, 7)) {
        outcomes.push({ month, status: 'deferred', detail: 'A month in progress cannot be frozen.' });
        continue;
      }
      const existing = await tx
        .select({ platform: schema.baselineSnapshots.platform, metric: schema.baselineSnapshots.metric })
        .from(schema.baselineSnapshots)
        .where(and(eq(schema.baselineSnapshots.tenantId, options.tenantId), eq(schema.baselineSnapshots.month, `${month}-01`)));
      const frozen = new Set(existing.map((r) => `${r.platform}|${r.metric}`));
      const figures = (await channelFigures(tx, options.tenantId, month)).filter(
        (f) =>
          !(f.platform === context.platform && rampCovered.has(f.metric)) && !frozen.has(`${f.platform}|${f.metric}`),
      );
      if (figures.length === 0) {
        outcomes.push({ month, status: 'already_frozen', detail: 'Every channel figure is frozen already.' });
        continue;
      }
      if (!options.dryRun) {
        await tx.insert(schema.baselineSnapshots).values(
          figures.map((f) => ({
            tenantId: options.tenantId,
            month: `${month}-01`,
            platform: f.platform,
            metric: f.metric,
            version: 1,
            value: f.value === null ? null : String(f.value),
            notMeasuredReason: f.value === null ? 'Nothing to divide by in this month.' : null,
            frozenAt: now,
            frozenBy: options.by,
            reason: options.reason,
          })),
        );
      }
      outcomes.push({
        month,
        status: 'frozen',
        detail: `${options.dryRun ? '(dry run) ' : ''}${figures
          .map((f) => `${f.platform} ${f.metric}=${f.value === null ? '—' : Math.round(f.value * 100) / 100}`)
          .join(', ')}`,
      });
    }
  });
  return outcomes;
}

/**
 * A correction to a frozen ramp month: the named metrics recomputed now with
 * `monthFigures` and inserted as the next version, with who and why. Nothing
 * is edited — the earlier version stays, and readers take the highest.
 *
 * First used 24 September 2026, for June's CPA and cost per funded deal,
 * frozen blank under the minimum-deal rule that was then reversed for costs.
 */
export async function correctBaselineMonth(options: {
  tenantId: string;
  month: MonthKey;
  metrics: (typeof RAMP_METRICS)[number][];
  by: string;
  reason: string;
  now?: Date;
  dryRun?: boolean;
}): Promise<{ metric: string; version: number; before: number | null; after: number | null }[]> {
  const now = options.now ?? new Date();
  return withJobTenant(options.tenantId, async (tx) => {
    const context = await freezeContext(tx, options.tenantId, now);
    const figures = await monthFigures(tx, options.tenantId, context, options.month);
    const out: { metric: string; version: number; before: number | null; after: number | null }[] = [];
    for (const metric of options.metrics) {
      const [current] = await tx
        .select({ version: schema.baselineSnapshots.version, value: schema.baselineSnapshots.value })
        .from(schema.baselineSnapshots)
        .where(
          and(
            eq(schema.baselineSnapshots.tenantId, options.tenantId),
            eq(schema.baselineSnapshots.platform, context.platform),
            eq(schema.baselineSnapshots.month, `${options.month}-01`),
            eq(schema.baselineSnapshots.metric, metric),
          ),
        )
        .orderBy(sql`${schema.baselineSnapshots.version} desc`)
        .limit(1);
      if (!current) throw new Error(`${options.month} ${metric} is not frozen; freeze it rather than correct it.`);
      const f = figures[metric];
      const version = current.version + 1;
      if (!options.dryRun) {
        await tx.insert(schema.baselineSnapshots).values({
          tenantId: options.tenantId,
          month: `${options.month}-01`,
          platform: context.platform,
          metric,
          version,
          value: f.value === null ? null : String(f.value),
          notMeasuredReason: f.value === null ? f.reason : null,
          channelSpend: f.cost ? String(f.cost.channelSpend) : null,
          attributed: f.cost ? String(f.cost.attributedDeals) : null,
          unattributed: f.cost ? String(f.cost.unattributedDeals) : null,
          attributedElsewhere: f.cost ? String(f.cost.dealsAttributedElsewhere) : null,
          rangeLow: f.cost?.plausibleRange.low == null ? null : String(f.cost.plausibleRange.low),
          rangeHigh: f.cost?.plausibleRange.high == null ? null : String(f.cost.plausibleRange.high),
          frozenAt: now,
          frozenBy: options.by,
          reason: options.reason,
        });
      }
      out.push({ metric, version, before: current.value === null ? null : Number(current.value), after: f.value });
    }
    return out;
  });
}
