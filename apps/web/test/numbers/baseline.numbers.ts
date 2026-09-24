/**
 * The pre-deploy number check: every frozen baseline figure, computed again
 * with the code being deployed, must equal what was frozen — or be listed in
 * `baseline-exceptions.ts` with a reason. Run by `pnpm --filter @zeeraa/web
 * numbers`, which the deploy runs after preflight.
 *
 * Each frozen figure is recomputed two ways: through the screens' code (the
 * ramp's live month for its six metrics, `monthlyPerformance` for the rest)
 * and through the ingestion side's (`monthFigures` / `channelFigures`, which
 * the freeze itself used). Both must match the snapshot.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { monthRange } from '@zeeraa/core';
import { schema } from '@zeeraa/db';
import { freezeContext, monthFigures } from '@zeeraa/jobs';
import { monthlyPerformance } from '@/lib/reporting';
import { BASELINE_EXCEPTIONS } from './baseline-exceptions';
import { fromIngestion, fromMonthlyPerformance, fromRamp, key, RAMP_TO_FIGURE, readOnly, same, tenants } from './figures';

type Frozen = { month: string; platform: string; metric: string; value: number | null };

describe('the frozen baseline, recomputed with this code', () => {
  it('matches every frozen figure, or the difference is listed with a reason', async () => {
    const problems: string[] = [];
    const explained: string[] = [];
    const usedExceptions = new Set<number>();
    let checked = 0;

    for (const t of await tenants()) {
      const frozen = await readOnly(async (tx) => {
        const rows = await tx.execute<{ month: string; platform: string; metric: string; value: string | null }>(sql`
          select distinct on (month, platform, metric)
                 to_char(month, 'YYYY-MM') as month, platform, metric, value
          from ${schema.baselineSnapshots}
          where tenant_id = ${t.session.tenant.id}
          order by month, platform, metric, version desc`);
        return rows.map((r): Frozen => ({ ...r, value: r.value === null ? null : Number(r.value) }));
      });
      if (frozen.length === 0) continue;
      const months = [...new Set(frozen.map((f) => f.month))];
      const ramp = await fromRamp(t, months);

      for (const month of months) {
        const mp = await monthlyPerformance(t.session, monthRange(month), 'last_touch');
        const screens = fromMonthlyPerformance(mp);
        const ingestion = await fromIngestion(t, month);
        const valueStage = mp.valueStageKey;
        const rampFreeze = await readOnly(async (tx) =>
          monthFigures(tx, t.session.tenant.id, await freezeContext(tx, t.session.tenant.id, new Date()), month),
        ).catch(() => null);

        for (const f of frozen.filter((r) => r.month === month)) {
          checked += 1;
          const isRamp = Object.hasOwn(RAMP_TO_FIGURE, f.metric);
          const figure = isRamp ? RAMP_TO_FIGURE[f.metric]!(valueStage) : f.metric;
          const computed: Record<string, number | null | undefined> = isRamp
            ? {
                'the ramp (screens)': ramp?.values.get(month)?.get(key(f.platform, figure ?? '')),
                'the freeze (ingestion)': rampFreeze ? rampFreeze[f.metric as keyof typeof rampFreeze]?.value : undefined,
              }
            : {
                'Monthly performance (screens)': screens.get(key(f.platform, f.metric)),
                'channel figures (ingestion)': ingestion.get(key(f.platform, f.metric)),
              };
          for (const [source, value] of Object.entries(computed)) {
            if (value === undefined) {
              problems.push(`${t.slug} ${month} ${f.platform} ${f.metric}: ${source} does not compute this figure`);
              continue;
            }
            if (same(value, f.value)) continue;
            const i = BASELINE_EXCEPTIONS.findIndex(
              (e) => e.tenant === t.slug && e.month === month && e.platform === f.platform && e.metric === f.metric,
            );
            const line = `${t.slug} ${month} ${f.platform} ${f.metric}: frozen ${f.value ?? 'blank'}, ${source} ${value ?? 'blank'}`;
            if (i === -1) problems.push(line);
            else {
              usedExceptions.add(i);
              explained.push(`${line} — ${BASELINE_EXCEPTIONS[i]!.reason}`);
            }
          }
        }
      }
    }

    BASELINE_EXCEPTIONS.forEach((e, i) => {
      if (!usedExceptions.has(i)) {
        problems.push(`${e.tenant} ${e.month} ${e.platform} ${e.metric}: listed as an exception but no longer differs — remove it`);
      }
    });
    console.log(`Baseline: ${checked} frozen figures checked, ${explained.length} explained differences.`);
    for (const line of explained) console.log(`  explained: ${line}`);
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
