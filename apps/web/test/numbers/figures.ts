/**
 * Every key figure, read the way each screen reads it, keyed identically so
 * the sources can be compared: `google_ads|stage:funded`, `meta|spend`,
 * `unattributed|stage:lead`. See `packages/jobs/src/channel-figures.ts` for
 * the ingestion side's version of the same list.
 */
import { sql } from 'drizzle-orm';
import { getMaintenanceDb, schema, withMaintenance, type Database } from '@zeeraa/db';
import { isPaidChannel, monthRange, platformLabel as corePlatformLabel, tenantDay, type DateRange } from '@zeeraa/core';
import { channelFigures, UNATTRIBUTED } from '@zeeraa/jobs';
import type { TenantSession } from '@/lib/tenant';
import { monthlyPerformance, type MonthlyPerformance } from '@/lib/reporting';
import { engagementRamp, loadMetrics, windowBuckets, type WindowBucket } from '@/lib/dashboard';
import { sourcesThrough } from '@/lib/coverage';
import { platformView } from '@/lib/platform';
import { buildRampPanels } from '@/lib/ramp-panels';

export type Figures = Map<string, number | null>;
export const key = (platform: string, metric: string) => `${platform}|${metric}`;

/** The ramp's six metrics, under the channel-figure names they correspond to. */
export const RAMP_TO_FIGURE: Record<string, (valueStage: string | null) => string | null> = {
  budget: () => 'spend',
  approvals: () => 'stage:uw_approved',
  fundedDeals: (v) => (v ? `stage:${v}` : null),
  fundedAmount: () => 'funded_volume',
  cpa: () => 'cpa',
  costPerFundedDeal: () => 'cost_per_funded',
};

export async function readOnly<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
  return getMaintenanceDb().transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    await tx.execute(sql`select set_config('app.maintenance', 'on', true)`);
    return fn(tx as unknown as Database);
  });
}

export type Tenant = { session: TenantSession; slug: string; today: string };

/** Every tenant with anything to report on. */
export async function tenants(): Promise<Tenant[]> {
  const rows = await withMaintenance(getMaintenanceDb(), (tx) =>
    tx.execute<{ id: string; name: string; slug: string; timezone: string; currency: string }>(sql`
      select t.id, t.name, t.slug, t.timezone, t.currency from ${schema.tenants} t
      where exists (select 1 from ${schema.leads} l where l.tenant_id = t.id)
         or exists (select 1 from ${schema.dailyMetrics} d where d.tenant_id = t.id)
      order by t.slug`),
  );
  const nobody = '00000000-0000-0000-0000-000000000000';
  return rows.map((t) => ({
    slug: t.slug,
    today: tenantDay(new Date(), t.timezone),
    session: {
      viewer: { userId: nobody, email: 'numbers-check', name: null, image: null, mustChangePassword: false, tenants: [] },
      tenant: { id: t.id, name: t.name, slug: t.slug, accentColor: '#000', timezone: t.timezone, currency: t.currency ?? 'USD', role: 'zeeraa_admin' },
      context: { tenantId: t.id, userId: nobody, role: 'zeeraa_admin' },
    } as unknown as TenantSession,
  }));
}

const cpa = (spend: number, n: number) => (n > 0 ? spend / n : null);

/** Monthly performance, Executive efficiency, the funnel, the CSV export. */
export function fromMonthlyPerformance(mp: MonthlyPerformance): Figures {
  const f: Figures = new Map();
  const value = mp.valueStageKey;
  for (const c of mp.channels) {
    for (const s of mp.stages) f.set(key(c.platform, `stage:${s.key}`), c.stages[s.key] ?? 0);
    f.set(key(c.platform, 'funded_volume'), value ? c.valueVolume : null);
    // An unpaid source (organic search) has counts and volume, and no money
    // figures on any screen — the same keys `channelFigures` emits for it.
    if (!isPaidChannel(c.platform)) continue;
    f.set(key(c.platform, 'spend'), c.spend);
    f.set(key(c.platform, 'cpa'), cpa(c.spend, c.stages.uw_approved ?? 0));
    f.set(key(c.platform, 'cost_per_funded'), c.costPerDeal.value);
  }
  for (const s of mp.stages) f.set(key(UNATTRIBUTED, `stage:${s.key}`), mp.unattributed.stages[s.key] ?? 0);
  return f;
}

/** The ramp, the scorecard, the monthly charts: one calendar-month bucket. */
export function fromBucket(b: WindowBucket, stages: { key: string }[], platforms: string[], value: string | null): Figures {
  const f: Figures = new Map();
  for (const p of platforms) {
    const st = b.stagesByPlatform[p] ?? {};
    for (const s of stages) f.set(key(p, `stage:${s.key}`), st[s.key] ?? 0);
    f.set(key(p, 'funded_volume'), value ? (b.valueVolumeByPlatform[p] ?? 0) : null);
    if (!isPaidChannel(p)) continue;
    const spend = b.spendByPlatform[p] ?? 0;
    f.set(key(p, 'spend'), spend);
    f.set(key(p, 'cpa'), cpa(spend, st.uw_approved ?? 0));
    f.set(key(p, 'cost_per_funded'), value ? cpa(spend, st[value] ?? 0) : null);
  }
  for (const s of stages) f.set(key(UNATTRIBUTED, `stage:${s.key}`), b.unattributedStages[s.key] ?? 0);
  return f;
}

/** A platform page: its spend and its own cost per funded deal. */
export async function fromPlatformPages(t: Tenant, range: DateRange, mp: MonthlyPerformance): Promise<Figures> {
  const f: Figures = new Map();
  const valueStage = mp.stages.find((s) => s.countsValue);
  for (const c of mp.channels) {
    // Organic search has no platform page of its own; its traffic is GA4's.
    if (!isPaidChannel(c.platform)) continue;
    const view = await platformView(t.session, c.platform, corePlatformLabel(c.platform), range, valueStage ? { key: valueStage.key, label: valueStage.label } : null, 'last_touch');
    f.set(key(c.platform, 'spend'), view.totals.spend);
    f.set(key(c.platform, 'cost_per_funded'), view.outcomes.cost.value);
    if (valueStage) f.set(key(c.platform, `stage:${valueStage.key}`), view.outcomes.cost.attributedDeals);
  }
  return f;
}

/** The ingestion side: what the freeze and the reconciliation compute. */
export async function fromIngestion(t: Tenant, month: string): Promise<Figures> {
  const rows = await readOnly((tx) => channelFigures(tx, t.session.tenant.id, month));
  return new Map(rows.map((r) => [key(r.platform, r.metric), r.value]));
}

/** The ramp's live figures for a month (the frozen snapshot bypassed). */
export async function fromRamp(t: Tenant, months: string[]): Promise<{ platform: string; values: Map<string, Figures> } | null> {
  const ramp = await engagementRamp(t.session);
  if (ramp.byPlatform.size === 0) return null;
  const first = months.slice().sort()[0]!;
  const range = { start: `${first}-01`, end: t.today };
  const [buckets, metrics, through, mp] = await Promise.all([
    windowBuckets(t.session, range, 'month', 'last_touch'),
    loadMetrics(t.session),
    sourcesThrough(t.session),
    monthlyPerformance(t.session, monthRange(first), 'last_touch'),
  ]);
  const valueStage = mp.stages.find((s) => s.countsValue);
  const panels = buildRampPanels({
    buckets,
    metrics,
    ramp,
    frozen: new Map(),
    through,
    valueKey: valueStage?.key ?? null,
    valueLabel: valueStage?.label ?? 'Funded',
    currency: t.session.tenant.currency,
    currentMonth: t.today.slice(0, 7),
  });
  const values = new Map<string, Figures>();
  for (const month of months) {
    const f: Figures = new Map();
    for (const [metric, toFigure] of Object.entries(RAMP_TO_FIGURE)) {
      const name = toFigure(valueStage?.key ?? null);
      if (name) f.set(key(panels.platform, name), panels.monthActual(metric as never, month).value);
    }
    values.set(month, f);
  }
  return { platform: panels.platform, values };
}

/** Frozen money is stored to four places; counts are whole. */
export function same(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(Math.round(a * 10_000) - Math.round(b * 10_000)) <= 1;
}
