/**
 * Cross-screen consistency: the same figure for the same period and channel
 * must be the same number on every screen that shows it. Fails the build if
 * any two disagree.
 *
 * For each of the last three complete months, per channel: Monthly
 * performance / Executive / Funnel / the CSV (`monthlyPerformance`), the ramp,
 * scorecard and monthly charts (a `windowBuckets` month), the platform pages
 * (`platformView`) and the ingestion side (`channelFigures`, which the freeze
 * and reconciliation use). And for the trailing 90 days: the Breakdown's rows
 * summed against the funnel's totals.
 */
import { describe, expect, it } from 'vitest';
import { addDays, monthRange, previousMonth, type DateRange } from '@zeeraa/core';
import { monthlyPerformance } from '@/lib/reporting';
import { windowBuckets } from '@/lib/dashboard';
import { BREAKDOWN_DIMENSIONS, breakdownAvailability, breakdownRows } from '@/lib/breakdown';
import { fromBucket, fromIngestion, fromMonthlyPerformance, fromPlatformPages, same, tenants, type Figures } from './figures';

function disagreements(label: string, sources: Record<string, Figures>): string[] {
  const keys = new Set(Object.values(sources).flatMap((f) => [...f.keys()]));
  const out: string[] = [];
  for (const k of [...keys].sort()) {
    const values = Object.entries(sources).filter(([, f]) => f.has(k)).map(([name, f]) => [name, f.get(k)] as const);
    if (values.length < 2) continue;
    const [, first] = values[0]!;
    if (values.every(([, v]) => same(v, first))) continue;
    out.push(`${label} ${k}: ${values.map(([n, v]) => `${n} ${v ?? 'blank'}`).join(' · ')}`);
  }
  return out;
}

describe('the same figure on every screen', () => {
  it('agrees across screens for each of the last three complete months, per channel', async () => {
    const problems: string[] = [];
    let compared = 0;
    for (const t of await tenants()) {
      let month = previousMonth(t.today.slice(0, 7));
      const months: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        months.unshift(month);
        month = previousMonth(month);
      }
      const buckets = await windowBuckets(t.session, { start: `${months[0]}-01`, end: t.today }, 'month', 'last_touch');
      for (const m of months) {
        const range: DateRange = monthRange(m);
        const mp = await monthlyPerformance(t.session, range, 'last_touch');
        const bucket = buckets.find((b) => b.start.startsWith(m));
        const platforms = mp.channels.map((c) => c.platform);
        const sources: Record<string, Figures> = {
          'Monthly performance': fromMonthlyPerformance(mp),
          'platform pages': await fromPlatformPages(t, range, mp),
          'channel figures': await fromIngestion(t, m),
          ...(bucket ? { 'ramp/charts': fromBucket(bucket, mp.stages, platforms, mp.valueStageKey) } : {}),
        };
        compared += Object.values(sources).reduce((n, f) => n + f.size, 0);
        problems.push(...disagreements(`${t.slug} ${m}`, sources));
      }
    }
    console.log(`Consistency: ${compared} figures compared.`);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('Breakdown rows sum to the funnel for the trailing 90 days', async () => {
    const problems: string[] = [];
    for (const t of await tenants()) {
      const range = { start: addDays(t.today, -89), end: t.today };
      const mp = await monthlyPerformance(t.session, range, 'last_touch');
      const stages = mp.stages.filter((s) => !mp.stageStatus[s.key]?.blocked);
      const available = await breakdownAvailability(t.session, range);
      for (const d of BREAKDOWN_DIMENSIONS.filter((x) => available.includes(x.key))) {
        const rows = await breakdownRows(t.session, range, d.key, stages.map((s) => ({ key: s.key, source: s.source })));
        for (const s of stages) {
          const sum = rows.reduce((n, r) => n + (r.counts[s.key] ?? 0), 0);
          const total = mp.total.stages[s.key] ?? 0;
          if (sum !== total) problems.push(`${t.slug} last 90 days, Breakdown by ${d.label}, ${s.key}: rows sum to ${sum}, funnel says ${total}`);
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
