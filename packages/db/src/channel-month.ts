import { and, eq, gte, lte, sql } from 'drizzle-orm';
import * as schema from './schema/index';
import { leadChannel, leadsCreatedIn, stageEventsIn } from './periods';
import type { Database } from './client';

/**
 * One channel's month, as the ramp and the baseline read it.
 *
 * The inputs to every contracted metric for one calendar month of one
 * channel: its spend, its own deals at the approval and value stages, the
 * deals no channel claims, its funded volume, and which days of its spend were
 * actually read. Counted exactly as `windowBuckets` counts a bucket — one deal
 * once per stage, the stage's `excluded_reason` honoured, attribution by
 * `model` — so a frozen baseline and a live ramp month cannot disagree about
 * what a month contained.
 *
 * Written for the jobs that have no signed-in person: the daily
 * reconciliation and the baseline freeze run on the ingestion role, where the
 * web app's report functions (which go through a membership) cannot.
 */
export type ChannelMonth = {
  month: string;
  platform: string;
  spend: number;
  /** Per stage: this channel's deals, deals credited to nobody, and every deal. */
  stages: Record<string, { own: number; unattributed: number; all: number }>;
  /** Funded amount on this channel's value-stage deals. */
  ownVolume: number;
  /** Days of the month this channel's spend was read (`sync_days`). */
  readDays: string[];
  /** The channel's first and last read day overall, or null if never read. */
  firstRead: string | null;
  lastRead: string | null;
};

export async function channelMonth(
  tx: Database,
  options: {
    tenantId: string;
    platform: string;
    /** `YYYY-MM`. */
    month: string;
    stages: readonly string[];
    valueStage: string | null;
    model?: 'first_touch' | 'last_touch';
    /**
     * Stages counted from leads rather than stage events — `lead`, and `mql`
     * narrowed to leads that pass the bar — by the lead's own click, exactly
     * as `monthlyPerformance` counts them. Added 24 September 2026 so the
     * frozen baseline can hold every funnel figure, not only the ramp's.
     */
    leadStages?: readonly { key: string; qualifiedOnly: boolean }[];
  },
): Promise<ChannelMonth> {
  const { tenantId, platform, month, stages, valueStage } = options;
  const leadStages = options.leadStages ?? [];
  const model = options.model ?? 'last_touch';
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const end = new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);

  const [spendRow] = await tx
    .select({ spend: sql<string>`coalesce(sum(${schema.dailyMetrics.spend}), 0)` })
    .from(schema.dailyMetrics)
    .where(
      and(
        eq(schema.dailyMetrics.tenantId, tenantId),
        eq(schema.dailyMetrics.platform, platform),
        gte(schema.dailyMetrics.date, start),
        lte(schema.dailyMetrics.date, end),
      ),
    );

  // No deal stages configured is no query, not `in ()`.
  const stageRows = stages.length === 0 ? [] : await tx
    .select({
      stage: schema.stageEvents.stage,
      platform: schema.attribution.platform,
      deals: sql<number>`count(distinct ${schema.stageEvents.opportunityExternalId})::int`,
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
        stageEventsIn({ start, end }),
        sql`${schema.stageEvents.stage} in (${sql.join(stages.map((s) => sql`${s}`), sql`, `)})`,
      ),
    )
    .groupBy(schema.stageEvents.stage, schema.attribution.platform);

  const counts: ChannelMonth['stages'] = {};
  for (const stage of stages) counts[stage] = { own: 0, unattributed: 0, all: 0 };
  for (const row of stageRows) {
    const c = counts[row.stage]!;
    c.all += Number(row.deals);
    if (row.platform === platform) c.own += Number(row.deals);
    else if (!row.platform) c.unattributed += Number(row.deals);
  }

  for (const stage of leadStages) {
    const rows = await tx
      .select({ clickIdType: leadChannel(), n: sql<number>`count(*)::int` })
      .from(schema.leads)
      .where(
        and(
          eq(schema.leads.tenantId, tenantId),
          leadsCreatedIn({ start, end }),
          ...(stage.qualifiedOnly ? [eq(schema.leads.mqlVerdict, 'qualified')] : []),
        ),
      )
      .groupBy(leadChannel());
    const c = { own: 0, unattributed: 0, all: 0 };
    for (const row of rows) {
      c.all += Number(row.n);
      if (row.clickIdType === platform) c.own += Number(row.n);
      else if (!row.clickIdType) c.unattributed += Number(row.n);
    }
    counts[stage.key] = c;
  }

  let ownVolume = 0;
  if (valueStage) {
    const [row] = await tx
      .select({
        volume: sql<string>`coalesce(sum(coalesce(o.funded_amount, o.amount, 0)), 0)`,
      })
      .from(
        sql`(
          select distinct e.opportunity_external_id
          from ${schema.stageEvents} e
          join ${schema.attribution} a
            on a.tenant_id = e.tenant_id and a.opportunity_external_id = e.opportunity_external_id
           and a.model = ${model} and a.platform = ${platform}
          where e.tenant_id = ${tenantId} and e.stage = ${valueStage}
            and e.excluded_reason is null
            and e.occurred_on between ${start} and ${end}
        ) d join ${schema.opportunities} o
          on o.tenant_id = ${tenantId} and o.external_id = d.opportunity_external_id`,
      );
    ownVolume = Number(row?.volume ?? 0);
  }

  const days = await tx
    .select({ day: sql<string>`to_char(${schema.syncDays.day}, 'YYYY-MM-DD')` })
    .from(schema.syncDays)
    .where(and(eq(schema.syncDays.tenantId, tenantId), eq(schema.syncDays.platform, platform)));
  const all = days.map((d) => d.day).sort();

  return {
    month,
    platform,
    spend: Number(spendRow?.spend ?? 0),
    stages: counts,
    ownVolume,
    readDays: all.filter((d) => d >= start && d <= end),
    firstRead: all[0] ?? null,
    lastRead: all.at(-1) ?? null,
  };
}
