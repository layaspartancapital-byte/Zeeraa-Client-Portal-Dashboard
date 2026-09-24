import { and, asc, eq, sql } from 'drizzle-orm';
import { channelMonth, schema, type Database } from '@zeeraa/db';
import { ORGANIC_SEARCH, type MonthKey } from '@zeeraa/core';

/**
 * Every key figure for one month, per channel, from the ingestion side
 * (24 September 2026): each funnel stage's count, and for a paid channel its
 * spend, funded volume, CPA and cost per funded deal. Computed with
 * `channelMonth`, the same counting the ramp and the reconciliation use.
 *
 * Two readers. The freeze writes these as the baseline for the figures the
 * ramp's six do not cover (`freezeChannelFigures`), and the pre-deploy number
 * check compares both this and the web app's report functions against what
 * was frozen, so a change that moves a frozen month's figure cannot deploy
 * without saying why.
 *
 * `unattributed` is a channel here for its stage counts only: it has no spend,
 * so no volume share, CPA or cost per deal. `organic_search` has its stage
 * counts and its funded volume, and no spend, CPA or cost per deal — it buys
 * nothing, so those are null rather than zero.
 */
export type ChannelFigure = { platform: string; metric: string; value: number | null };

export const UNATTRIBUTED = 'unattributed';

/** `stage:lead`, `stage:uw_approved` … and the money figures. */
export const stageMetric = (key: string) => `stage:${key}`;
export const MONEY_METRICS = ['spend', 'funded_volume', 'cpa', 'cost_per_funded'] as const;

export async function channelFigures(tx: Database, tenantId: string, month: MonthKey): Promise<ChannelFigure[]> {
  const stages = await tx
    .select({ key: schema.funnelStages.key, source: schema.funnelStages.source, countsValue: schema.funnelStages.countsValue })
    .from(schema.funnelStages)
    .where(eq(schema.funnelStages.tenantId, tenantId))
    .orderBy(asc(schema.funnelStages.position));
  const leadStages = stages
    .filter((s) => s.source === 'leads' || s.source === 'qualified_leads')
    .map((s) => ({ key: s.key, qualifiedOnly: s.source === 'qualified_leads' }));
  const dealStages = stages.filter((s) => !leadStages.some((l) => l.key === s.key)).map((s) => s.key);
  const valueStage = stages.find((s) => s.countsValue)?.key ?? null;
  const approval = dealStages.includes('uw_approved') ? 'uw_approved' : null;

  const platforms = (
    await tx
      .selectDistinct({ platform: schema.dailyMetrics.platform })
      .from(schema.dailyMetrics)
      .where(and(eq(schema.dailyMetrics.tenantId, tenantId), sql`to_char(${schema.dailyMetrics.date}, 'YYYY-MM') = ${month}`))
  )
    .map((r) => r.platform)
    .sort();

  const out: ChannelFigure[] = [];
  let unattributed: Record<string, number> | null = null;
  for (const platform of platforms.length > 0 ? platforms : ['none']) {
    const cm = await channelMonth(tx, { tenantId, platform, month, stages: dealStages, valueStage, leadStages });
    if (platform !== 'none') {
      for (const s of stages) out.push({ platform, metric: stageMetric(s.key), value: cm.stages[s.key]?.own ?? 0 });
      const own = (key: string | null) => (key ? (cm.stages[key]?.own ?? 0) : 0);
      out.push({ platform, metric: 'spend', value: cm.spend });
      out.push({ platform, metric: 'funded_volume', value: valueStage ? cm.ownVolume : null });
      out.push({ platform, metric: 'cpa', value: own(approval) > 0 ? cm.spend / own(approval) : null });
      out.push({ platform, metric: 'cost_per_funded', value: own(valueStage) > 0 ? cm.spend / own(valueStage) : null });
    }
    unattributed ??= Object.fromEntries(stages.map((s) => [s.key, cm.stages[s.key]?.unattributed ?? 0]));
  }
  for (const s of stages) out.push({ platform: UNATTRIBUTED, metric: stageMetric(s.key), value: unattributed?.[s.key] ?? 0 });

  const organic = await channelMonth(tx, { tenantId, platform: ORGANIC_SEARCH, month, stages: dealStages, valueStage, leadStages });
  if (stages.some((s) => (organic.stages[s.key]?.own ?? 0) > 0)) {
    for (const s of stages) out.push({ platform: ORGANIC_SEARCH, metric: stageMetric(s.key), value: organic.stages[s.key]?.own ?? 0 });
    out.push({ platform: ORGANIC_SEARCH, metric: 'funded_volume', value: valueStage ? organic.ownVolume : null });
  }
  return out;
}
