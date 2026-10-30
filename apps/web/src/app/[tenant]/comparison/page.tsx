import Link from 'next/link';
import {
  formatRangeLabel,
  monthRange,
  previousMonth,
  resolveDateRange,
  type AttributionModel,
  type DateRange,
  type RangePresetKey,
} from '@zeeraa/core';
import { AutoRefresh } from '@/components/shell/AutoRefresh';
import { ExportEverything, ExportScope } from '@/components/export/ExportScope';
import { Card, Grid } from '@/components/ui/Card';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { MethodDrawer, MethodNotesForPrint, type MethodNote } from '@/components/ui/Drawer';
import { PageMeta, TopBar } from '@/components/shell/TopBar';
import { PrintButton } from '@/components/shell/actions';
import { ComparisonView } from '@/components/ComparisonView';
import { comparisonReport } from '@/lib/cached-reports';
import { resolvePageRange } from '@/lib/range';
import { requireTenant } from '@/lib/tenant';

export const metadata = { title: 'Comparison' };

type Query = {
  aFrom?: string;
  aTo?: string;
  aPreset?: string;
  bFrom?: string;
  bTo?: string;
  bPreset?: string;
  source?: string;
  model?: string;
};

/**
 * Two periods side by side, for one source (30 October 2026).
 *
 * Each period has its own picker — the same control as every other page,
 * under its own params (`aFrom`/`aTo`, `bFrom`/`bTo`). With none given, A is
 * this month to date and B the previous full month. Every KPI is a row, with the
 * change and the change in per cent; a count's change is stated even when the
 * periods differ in length, and the page says so above the table (a departure
 * from Executive's two-figure rule, recorded in `docs/brief-amendments.md`).
 */
export default async function ComparisonPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<Query>;
}) {
  const { tenant: slug } = await params;
  const query = await searchParams;
  const session = await requireTenant(slug);
  const model: AttributionModel = query.model === 'first_touch' ? 'first_touch' : 'last_touch';
  const { today, earliest } = await resolvePageRange(session, {});

  const lastMonth = previousMonth(today.slice(0, 7));
  const resolve = (from?: string, to?: string, preset?: string, fallback?: DateRange) => {
    if (!from && !to && !preset && fallback) return { range: fallback, preset: null as RangePresetKey | null, problem: null };
    return resolveDateRange({ from, to, preset, today, earliest });
  };
  // By default A is this month to date (the MTD preset, so its pill reads as
  // chosen) and B the previous full month.
  const a = query.aFrom || query.aTo || query.aPreset
    ? resolve(query.aFrom, query.aTo, query.aPreset)
    : resolveDateRange({ preset: 'mtd', today, earliest });
  const b = resolve(query.bFrom, query.bTo, query.bPreset, monthRange(lastMonth));

  const asked = query.source && /^[A-Za-z0-9_:]{1,64}$/.test(query.source) ? query.source : 'all';
  let comparison = await comparisonReport(session, { a: a.range, b: b.range, source: asked, model });
  // A source neither period has, or a mistyped one, is All sources.
  if (!comparison.sources.some((s) => s.key === asked)) {
    comparison = await comparisonReport(session, { a: a.range, b: b.range, source: 'all', model });
  }
  const source = comparison.source;

  // Each picker carries the other period, the source and the model, so
  // changing one period never resets the other.
  const base = `/${slug}/comparison`;
  const current = {
    aFrom: a.range.start,
    aTo: a.range.end,
    bFrom: b.range.start,
    bTo: b.range.end,
    source,
    ...(model === 'first_touch' ? { model } : {}),
  };
  const without = (...keys: string[]) =>
    Object.fromEntries(Object.entries(current).filter(([k]) => !keys.includes(k))) as Record<string, string>;
  const presetHref = (period: 'a' | 'b') => (key: RangePresetKey) =>
    `${base}?${new URLSearchParams({ ...without(`${period}From`, `${period}To`), [`${period}Preset`]: key }).toString()}`;
  const sourceHref = (key: string) => `${base}?${new URLSearchParams({ ...current, source: key }).toString()}`;

  const notes: MethodNote[] = [
    {
      heading: 'The two periods',
      body:
        'Period A and Period B are picked separately; by default A is this month to date and B the previous full month. ' +
        'Change is A minus B, and % change is that over B.',
      detail:
        'A count or a total covers its own number of days, so when the periods differ in length the page says so: ' +
        'compare rates and costs first. A rate’s change is in percentage points.',
    },
    {
      heading: 'Sources',
      body:
        'All sources is every source together: costs are every ad platform’s spend over every source’s leads, ' +
        'approvals and deals. A single source’s costs are its own spend over its own records; a source with no ad ' +
        'spend has no ad or cost figures, shown as —, never 0.',
      detail: 'Calls are not split by source, so they appear for All sources only; SEO for All sources and SEO/Organic.',
    },
    {
      heading: 'Colours, targets and frozen months',
      body:
        'A change is green when the metric moved the way that is better for it and red when it did not — a rising ' +
        'cost is red. The Zeeraa contract’s target is shown beside a figure for a period that is one calendar month.',
      detail:
        'A period that is one frozen calendar month reads spend, stage counts and funded volume from the frozen ' +
        'baseline; rates between stages are read live.',
    },
  ];

  return (
    <ExportScope
      value={{
        slug,
        page: 'comparison',
        from: a.range.start,
        to: a.range.end,
        model,
        source: source === 'all' ? null : source,
        extra: { bFrom: b.range.start, bTo: b.range.end },
      }}
    >
      <TopBar tenant={session.tenant} viewer={session.viewer} title="Comparison">
        <ExportEverything />
        <PrintButton />
      </TopBar>

      <PageMeta>
        <AutoRefresh />
        <MethodDrawer notes={notes} title={`Comparison · ${formatRangeLabel(a.range)} vs ${formatRangeLabel(b.range)}`} />
      </PageMeta>

      <Grid>
        <Card span={12} className="gap-4 px-5 py-4">
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <DateRangePicker
              label="Period A"
              names={{ from: 'aFrom', to: 'aTo' }}
              range={a.range}
              preset={a.preset}
              presetHref={presetHref('a')}
              preserve={without('aFrom', 'aTo')}
              problem={a.problem}
              earliest={earliest}
              today={today}
            />
            <DateRangePicker
              label="Period B"
              names={{ from: 'bFrom', to: 'bTo' }}
              range={b.range}
              preset={b.preset}
              presetHref={presetHref('b')}
              preserve={without('bFrom', 'bTo')}
              problem={b.problem}
              earliest={earliest}
              today={today}
            />
          </div>
          <nav aria-label="Source" className="flex min-w-0 flex-wrap gap-1.5 print-hidden">
            {comparison.sources.map((s) => (
              <Link
                key={s.key}
                href={sourceHref(s.key)}
                scroll={false}
                aria-current={s.key === source ? 'true' : undefined}
                className={`rounded-[6px] border px-2.5 py-1 text-[13px] font-medium ${
                  s.key === source ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-2 hover:text-text'
                }`}
              >
                {s.label}
              </Link>
            ))}
          </nav>
          {comparison.lengthNote && (
            <p role="note" className="text-[13px] text-text-2">
              {comparison.lengthNote}
            </p>
          )}
        </Card>

        <ComparisonView comparison={comparison} currency={session.tenant.currency} />
      </Grid>

      <MethodNotesForPrint notes={notes} />
    </ExportScope>
  );
}
