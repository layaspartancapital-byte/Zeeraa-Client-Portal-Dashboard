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
import { monthlyPerformance, submissionReport } from '@/lib/reporting';
import { windowBuckets } from '@/lib/dashboard';
import { BREAKDOWN_DIMENSIONS, breakdownAvailability, breakdownRows } from '@/lib/breakdown';
import { fromBucket, fromIngestion, fromMonthlyPerformance, fromPlatformPages, readOnly, same, tenants, type Figures } from './figures';
import { sql } from 'drizzle-orm';

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

  it('the parts add up to the whole on Executive and Funnel (24 September 2026)', async () => {
    const problems: string[] = [];
    for (const t of await tenants()) {
      for (const range of [
        { start: addDays(t.today, -89), end: t.today },
        { start: `${t.today.slice(0, 7)}-01`, end: t.today },
      ]) {
        const label = `${t.slug} ${range.start}–${range.end}`;
        const mp = await monthlyPerformance(t.session, range, 'last_touch');
        const v = mp.valueStageKey;
        if (v) {
          // All funded: one row per source, each deal in one, summing to the total.
          const deals = mp.channels.reduce((n, c) => n + (c.stages[v] ?? 0), 0) + (mp.unattributed.stages[v] ?? 0);
          const volume = mp.channels.reduce((n, c) => n + c.valueVolume, 0) + mp.unattributed.valueVolume;
          if (deals !== (mp.total.stages[v] ?? 0)) problems.push(`${label} All funded: rows ${deals}, total ${mp.total.stages[v]}`);
          if (Math.abs(volume - mp.total.valueVolume) > 0.005) problems.push(`${label} All funded volume: rows ${volume}, total ${mp.total.valueVolume}`);
        }
        // Declines: the bars are the headline's deals, each in one month of the window.
        const bars = mp.declines.byMonth.reduce((n, m) => n + m.deals, 0);
        if (bars !== mp.declines.deals) problems.push(`${label} Declines: bars ${bars}, headline ${mp.declines.deals}`);
        if (mp.declines.byMonth.some((m) => m.month < range.start.slice(0, 7) || m.month > range.end.slice(0, 7))) {
          problems.push(`${label} Declines: a bar falls outside the window`);
        }
        // Lender outcomes: waiting + no reply before close + not completed is every undecided.
        const s = await submissionReport(t.session, range);
        const pending = s.pending.waiting + s.pending.closed_unanswered + s.pending.not_completed;
        if (pending !== s.overall.undecided) problems.push(`${label} Lender outcomes: split ${pending}, undecided ${s.overall.undecided}`);
        const byLender = s.lenders.reduce((n, l) => n + l.pending.waiting, 0);
        if (byLender !== s.pending.waiting) problems.push(`${label} Lender outcomes: table waiting ${byLender}, headline ${s.pending.waiting}`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('no merged or outbound lead is counted (24 September 2026)', async () => {
    // The sync clears every lead's excluded_reason before re-applying its
    // rules; a rule that is not re-applied puts those leads back into every
    // count. Held here against production, not only in a unit test.
    const problems: string[] = [];
    for (const t of await tenants()) {
      const [row] = await readOnly((tx) =>
        tx.execute<{ merged: number; value: unknown }>(sql`
          select (select count(*)::int from leads where tenant_id = ${t.session.tenant.id}
                    and merged_into is not null and excluded_reason is null) as merged,
                 (select value from tenant_config where tenant_id = ${t.session.tenant.id} and key = 'lead_exclusion') as value`),
      );
      if (Number(row?.merged ?? 0) > 0) problems.push(`${t.slug}: ${row!.merged} merged leads are counted`);
      const config = row?.value as { enabled?: boolean; rules?: { leadSources?: string[] }[] } | null;
      const sources = config?.enabled ? (config.rules ?? []).flatMap((r) => r.leadSources ?? []) : [];
      if (sources.length > 0) {
        const [outbound] = await readOnly((tx) =>
          tx.execute<{ n: number }>(sql`
            select count(*)::int as n from leads where tenant_id = ${t.session.tenant.id}
              and excluded_reason is null
              and lead_source in (${sql.join(sources.map((s) => sql`${s}`), sql`, `)})`),
        );
        if (Number(outbound?.n ?? 0) > 0) problems.push(`${t.slug}: ${outbound!.n} outbound leads (${sources.join(', ')}) are counted`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
