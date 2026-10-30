import 'server-only';
import { contractTarget, isVendorChannel, monthRange, platformLabel, sourceRank, type AttributionModel, type DateRange } from '@zeeraa/core';
import type { TenantSession } from '@/lib/tenant';
import * as cached from '@/lib/cached-reports';
import { coverageFor, isUnmeasured, notMeasuredReason } from '@/lib/coverage';
import {
  compareRows,
  funnelSteps,
  hasAdSpend,
  lengthNote,
  periodRows,
  type ComparisonCell,
  type ComparisonRow,
  type FunnelStep,
  type PeriodInput,
} from '@/lib/comparison-rows';

/**
 * The Comparison page (30 October 2026): two periods, one source, every KPI.
 * Reads each period through the cached reports the other screens use, so a
 * figure here is the figure there; the rows themselves are
 * `lib/comparison-rows.ts`.
 */
export type Comparison = {
  a: PeriodMeta;
  b: PeriodMeta;
  source: string;
  sources: { key: string; label: string }[];
  rows: ComparisonRow[];
  /** Said above the table when the periods differ in length. */
  lengthNote: string | null;
  /** Whether the source has ad spend; without it, no ad or cost figures are drawn. */
  paid: boolean;
  /** The funnel's steps, each naming its rows in `rows`. */
  funnel: FunnelStep[];
  /**
   * Funded deals and volume per source, each period read exactly as the
   * table reads that source. Only sources with a deal in either period.
   */
  bySource: { key: string; label: string; deals: [ComparisonCell, ComparisonCell]; volume: [ComparisonCell, ComparisonCell] }[];
};

export type PeriodMeta = {
  range: DateRange;
  /** The calendar month, where the period is exactly one. */
  month: string | null;
  /** Whether its figures are the frozen baseline. */
  frozen: boolean;
};

/** The calendar month a range is exactly, or null. */
export function wholeMonth(range: DateRange): string | null {
  const month = range.start.slice(0, 7);
  const m = monthRange(month);
  return m.start === range.start && m.end === range.end ? month : null;
}

async function periodInput(
  session: TenantSession,
  range: DateRange,
  source: string,
  model: AttributionModel,
): Promise<{ input: PeriodInput; meta: PeriodMeta; channels: string[] }> {
  const [mp, through, frozenAll, ramp, metrics] = await Promise.all([
    cached.monthlyPerformance(session, range, model),
    cached.sourcesThrough(session),
    cached.frozenBaseline(session),
    cached.engagementRamp(session),
    cached.loadMetrics(session),
  ]);
  const cover = coverageFor(through, range);
  const month = wholeMonth(range);

  // A frozen calendar month is read from its frozen channel figures.
  let frozen: Map<string, number> | null = null;
  if (month) {
    const figures = new Map<string, number>();
    for (const [key, f] of frozenAll) {
      const [platform, m, metric] = key.split('|');
      if (m !== month || f.value === null) continue;
      if (metric === 'spend' || metric === 'funded_volume' || metric!.startsWith('stage:')) figures.set(`${platform}|${metric}`, f.value);
    }
    if (figures.size > 0) frozen = figures;
  }

  const all = source === 'all';
  const calls = all ? await cached.callReport(session, range, await cached.alowareConnectedThreshold(session)) : null;
  let seo: PeriodInput['seo'] = null;
  if (all || source === 'organic_search') {
    const view = await cached.seoView(session, range);
    if (view.connection) {
      const endMonth = range.end.slice(0, 7);
      const snapshot = [...view.months].filter((m) => m.month <= endMonth).sort((x, y) => x.month.localeCompare(y.month)).at(-1) ?? null;
      const visibility = (view.tracking?.visibility ?? []).filter((v) => v.day >= range.start && v.day <= range.end).at(-1) ?? null;
      seo = {
        organicKeywords: snapshot && snapshot.month >= range.start.slice(0, 7) ? snapshot.organicKeywords : null,
        top10: snapshot && snapshot.month >= range.start.slice(0, 7) ? snapshot.positions1to3 + snapshot.positions4to10 : null,
        visibility: visibility?.value ?? null,
      };
    }
  }

  const input: PeriodInput = {
    range,
    mp,
    source,
    crmUnmeasured: isUnmeasured(cover.crm) ? notMeasuredReason(cover.crm, 'Salesforce') : null,
    spendUnmeasured: isUnmeasured(cover.spend) ? notMeasuredReason(cover.spend, 'Paid media') : null,
    callsUnmeasured: isUnmeasured(cover.calls) ? notMeasuredReason(cover.calls, 'Call tracking') : null,
    frozen,
    calls:
      calls && !calls.empty
        ? {
            handled: calls.volume.handled,
            connectRate: calls.volume.connectRate,
            medianSeconds: calls.speed.medianSeconds,
            withinFiveShare: calls.speed.withinFiveMinutesShare,
            called: calls.speed.called,
          }
        : null,
    seo,
    // The contract states monthly targets: shown for a period that is one calendar month.
    contract: month
      ? {
          cpa: contractTarget(ramp.contract, 'cpa', month),
          costPerFundedDeal: contractTarget(ramp.contract, 'costPerFundedDeal', month),
          fundedAmount: contractTarget(ramp.contract, 'fundedAmount', month),
        }
      : null,
    population: metrics.population,
  };
  return { input, meta: { range, month, frozen: frozen !== null }, channels: mp.channels.map((c) => c.platform) };
}

export async function comparisonReport(
  session: TenantSession,
  options: { a: DateRange; b: DateRange; source: string; model: AttributionModel },
): Promise<Comparison> {
  const [a, b] = await Promise.all([
    periodInput(session, options.a, options.source, options.model),
    periodInput(session, options.b, options.source, options.model),
  ]);
  const channels = [...new Set(['google_ads', 'meta', 'organic_search', ...a.channels, ...b.channels])].sort(
    (x, y) => sourceRank(x) - sourceRank(y) || (isVendorChannel(x) ? 1 : 0) - (isVendorChannel(y) ? 1 : 0) || platformLabel(x).localeCompare(platformLabel(y)),
  );
  const sources = [
    { key: 'all', label: 'All sources' },
    ...channels.map((key) => ({ key, label: platformLabel(key) })),
    { key: 'unattributed', label: 'Direct & other' },
  ];
  const bySource = sources
    .filter((s) => s.key !== 'all')
    .map((s) => {
      const ra = periodRows({ ...a.input, source: s.key });
      const rb = periodRows({ ...b.input, source: s.key });
      const pick = (rows: typeof ra, key: string) => rows.get(key)!.cell;
      return {
        key: s.key,
        label: s.label,
        deals: [pick(ra, 'funded_deals'), pick(rb, 'funded_deals')] as [ComparisonCell, ComparisonCell],
        volume: [pick(ra, 'funded_volume'), pick(rb, 'funded_volume')] as [ComparisonCell, ComparisonCell],
      };
    })
    .filter((s) => s.deals.some((c) => (c.value ?? 0) > 0));
  return {
    a: a.meta,
    b: b.meta,
    source: options.source,
    sources,
    rows: compareRows(periodRows(a.input), periodRows(b.input)),
    lengthNote: lengthNote(options.a, options.b),
    paid: hasAdSpend(options.source),
    funnel: funnelSteps(a.input.mp),
    bySource,
  };
}
