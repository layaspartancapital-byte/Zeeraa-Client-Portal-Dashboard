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
import { AD_DETAIL, addDays, isPaidChannel, isVendorChannel, cohortConversionRate, monthRange, platformLabel, previousMonth, stageBeforeValue, type DateRange } from '@zeeraa/core';
import { monthlyPerformance, submissionReport } from '@/lib/reporting';
import { windowBuckets } from '@/lib/dashboard';
import { BREAKDOWN_DIMENSIONS, breakdownAvailability, breakdownRows } from '@/lib/breakdown';
import { platformView } from '@/lib/platform';
import { allSources } from '@/lib/all-sources';
import { comparisonReport } from '@/lib/comparison';
import { fromBucket, fromContract, fromIngestion, fromMonthlyPerformance, fromPlatformPages, readOnly, same, tenants, type Figures } from './figures';
import { isProvenLeadChange, leadFigureProofs } from '@zeeraa/jobs';
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
      const contract = await fromContract(t, months);
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

        // The contract's measures (30 October 2026), read from the frozen
        // channel figures for a frozen month: they must be Monthly
        // performance's all-sources figures for the same month.
        const v = mp.valueStageKey;
        const c = contract?.get(m);
        if (v && c && c.fundedDeals !== null) {
          const all = allSources(mp);
          const kept = mp.channels.filter((ch) => !isVendorChannel(ch.platform));
          const expected = {
            cpa: all.cpa.value,
            costPerFundedDeal: all.costPerDeal.value,
            fundedAmount: kept.reduce((n, ch) => n + ch.valueVolume, 0) + mp.unattributed.valueVolume,
            fundedDeals: kept.reduce((n, ch) => n + (ch.stages[v] ?? 0), 0) + (mp.unattributed.stages[v] ?? 0),
          };
          for (const [metric, value] of Object.entries(expected) as [keyof typeof expected, number | null][]) {
            compared += 1;
            if (!same(c[metric], value)) problems.push(`${t.slug} ${m} contract ${metric}: ramp ${c[metric]}, Monthly performance ${value}`);
          }
        }
      }
    }
    console.log(`Consistency: ${compared} figures compared.`);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('Comparison shows each source’s figures as Monthly performance does (30 October 2026)', async () => {
    const problems: string[] = [];
    for (const t of await tenants()) {
      const last = previousMonth(t.today.slice(0, 7));
      // A frozen month's lead counts that Salesforce has since moved: the
      // baseline check lets them through until the daily job restates them,
      // and Comparison, which reads the frozen figure, differs by exactly that.
      const proofs = await readOnly((tx) => leadFigureProofs(tx, t.session.tenant.id, last));
      const provenLeadDelta = (source: string): number | null => {
        let delta = 0;
        for (const p of proofs.values()) {
          if (p.metric !== 'stage:lead' || (source !== 'all' && p.platform !== source) || p.frozen === p.now) continue;
          if (!isProvenLeadChange(p, p.frozen, p.now)) return null;
          delta += p.now - p.frozen!;
        }
        return delta;
      };
      for (const a of [monthRange(last), { start: `${t.today.slice(0, 7)}-01`, end: t.today }]) {
        const b = monthRange(previousMonth(a.start.slice(0, 7)));
        const mp = await monthlyPerformance(t.session, a, 'last_touch');
        const v = mp.valueStageKey;
        const first = await comparisonReport(t.session, { a, b, source: 'all', model: 'last_touch' });
        // "Funded by source" (30 October 2026): each source's bars are Monthly
        // performance's funded deals and volume for that source.
        for (const s of first.bySource) {
          const pick = s.key === 'unattributed' ? mp.unattributed : mp.channels.find((c) => c.platform === s.key);
          const deals = v ? ((pick?.stages as Record<string, number> | undefined)?.[v] ?? 0) : null;
          if (!same(s.deals[0].value, deals)) problems.push(`${t.slug} ${a.start}–${a.end} by source ${s.key} funded deals: Comparison ${s.deals[0].value}, Monthly performance ${deals}`);
          if (!same(s.volume[0].value, pick?.valueVolume ?? 0)) problems.push(`${t.slug} ${a.start}–${a.end} by source ${s.key} funded volume: Comparison ${s.volume[0].value}, Monthly performance ${pick?.valueVolume ?? 0}`);
        }
        for (const { key: source } of first.sources) {
          const report = source === 'all' ? first : await comparisonReport(t.session, { a, b, source, model: 'last_touch' });
          const row = (k: string) => report.rows.find((r) => r.key === k)?.a.value ?? null;
          const pick = source === 'all' ? mp.total : source === 'unattributed' ? mp.unattributed : mp.channels.find((c) => c.platform === source);
          if (!pick) continue;
          const stagesOf = pick.stages as Record<string, number>;
          const expected: Record<string, number | null> = {
            leads: stagesOf.lead ?? 0,
            applications: stagesOf.application ?? 0,
            funded_deals: v ? (stagesOf[v] ?? 0) : null,
            funded_volume: pick.valueVolume,
          };
          // The contract's volume: every source's but lead vendors', frozen
          // month or not (a frozen month once dropped the ramp channel's).
          if (source === 'all' && v) {
            expected.funded_volume_contract =
              mp.channels.filter((c) => !isVendorChannel(c.platform)).reduce((n, c) => n + c.valueVolume, 0) + mp.unattributed.valueVolume;
          }
          if (source === 'all' || (source !== 'unattributed' && isPaidChannel(source))) {
            const spend = source === 'all' ? mp.total.spend : (pick as { spend: number }).spend;
            expected.spend = spend;
            const deals = v ? (stagesOf[v] ?? 0) : 0;
            expected.cpfd = deals > 0 ? spend / deals : null;
          }
          for (const [k, value] of Object.entries(expected)) {
            if (same(row(k), value)) continue;
            const delta = k === 'leads' && a.start.startsWith(last) ? provenLeadDelta(source) : null;
            if (delta && same((row(k) ?? 0) + delta, value)) continue;
            problems.push(`${t.slug} ${a.start}–${a.end} ${source} ${k}: Comparison ${row(k)}, Monthly performance ${value}`);
          }
        }
      }
    }
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

  it('every funnel rate is a cohort of its stage, within 100% (25 September 2026)', async () => {
    const problems: string[] = [];
    let rates = 0;
    for (const t of await tenants()) {
      for (const range of [
        { start: addDays(t.today, -89), end: t.today },
        { start: `${t.today.slice(0, 7)}-01`, end: t.today },
      ]) {
        const mp = await monthlyPerformance(t.session, range, 'last_touch');
        const rows = [...mp.channels, mp.unattributed, mp.total];
        for (const row of rows) {
          const label = `${t.slug} ${range.start}–${range.end} ${row.label}`;
          for (const [i, from] of mp.stages.entries()) {
            const cohort = row.cohorts[from.key];
            // The chip's denominator is the card's figure: the cohort is the
            // records the card counted.
            if ((cohort?.size ?? 0) !== (row.stages[from.key] ?? 0)) {
              problems.push(`${label} ${from.key}: cohort ${cohort?.size ?? 0}, card ${row.stages[from.key] ?? 0}`);
            }
            for (const to of mp.stages.slice(i + 1)) {
              const r = cohortConversionRate(row.cohorts, from.key, to.key);
              rates += 1;
              if (r.rate !== null && (r.rate > 1 || r.rate < 0)) problems.push(`${label} ${from.key} → ${to.key}: ${r.numerator} of ${r.denominator}`);
            }
          }
        }
      }
    }
    console.log(`Cohorts: ${rates} funnel rates checked.`);
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
          // Its Offers column: the stage before value, by the same rows, summing to its total.
          const o = stageBeforeValue(mp.stages)?.key;
          if (o) {
            const offers = mp.channels.reduce((n, c) => n + (c.stages[o] ?? 0), 0) + (mp.unattributed.stages[o] ?? 0);
            if (offers !== (mp.total.stages[o] ?? 0)) problems.push(`${label} All funded offers: rows ${offers}, total ${mp.total.stages[o]}`);
            // Its offer amount: each deal once at its highest offer, so the rows add up too.
            const offered = [...mp.channels.map((c) => c.offered), mp.unattributed.offered];
            const amount = offered.reduce((n, x) => n + x.amount, 0);
            const withAmount = offered.reduce((n, x) => n + x.deals, 0);
            if (Math.abs(amount - mp.total.offered.amount) > 0.005 || withAmount !== mp.total.offered.deals) {
              problems.push(`${label} All funded offer amount: rows ${amount} over ${withAmount}, total ${mp.total.offered.amount} over ${mp.total.offered.deals}`);
            }
            if (mp.total.offered.deals > (mp.total.stages[o] ?? 0)) problems.push(`${label} All funded offer amount: more priced deals than offers`);
          }
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

  it('the funded-deals list has one row per deal the platform page counts (25 September 2026)', async () => {
    const problems: string[] = [];
    let rows = 0;
    for (const t of await tenants()) {
      const mp = await monthlyPerformance(t.session, { start: addDays(t.today, -89), end: t.today }, 'last_touch');
      const value = mp.stages.find((s) => s.key === mp.valueStageKey);
      if (!value) continue;
      const month = previousMonth(t.today.slice(0, 7));
      for (const platform of Object.keys(AD_DETAIL)) {
        for (const range of [
          monthRange(month),
          { start: `${t.today.slice(0, 7)}-01`, end: t.today },
          { start: addDays(t.today, -89), end: t.today },
        ]) {
          for (const model of ['first_touch', 'last_touch'] as const) {
            const view = await platformView(t.session, platform, platformLabel(platform), range, { key: value.key, label: value.label }, model);
            const list = view.outcomes.fundedDeals ?? [];
            const ids = new Set(list.map((d) => d.opportunityId));
            rows += list.length;
            if (list.length !== view.outcomes.cost.attributedDeals || ids.size !== list.length) {
              problems.push(
                `${t.slug} ${platform} ${range.start}–${range.end} ${model}: ` +
                  `${list.length} rows (${ids.size} distinct) against a count of ${view.outcomes.cost.attributedDeals}`,
              );
            }
          }
        }
      }
    }
    console.log(`Funded-deals lists: ${rows} rows checked.`);
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
