import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { formatCount, formatRangeLabel, formatRate, rangeLengthDays } from '@zeeraa/core';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { InfoTip } from '@/components/ui/InfoTip';
import { NotMeasuredBadge } from '@/components/ui/Badge';
import { toneFor } from '@/components/ui/delta-tone';
import { PairedBars, PERIOD_A, PERIOD_B } from '@/components/charts/PairedBars';
import { ExportButton } from '@/components/export/ExportScope';
import { ComparisonTable, formatValue, targetText } from '@/components/ComparisonTable';
import type { Comparison } from '@/lib/comparison';
import type { ComparisonCell, ComparisonFormat, ComparisonRow } from '@/lib/comparison-rows';

/**
 * The Comparison page laid out as Monthly performance is (30 October 2026):
 * headline cards, the funnel side by side, costs, funded by source, calls,
 * and every metric in a table folded away at the bottom.
 *
 * Every figure is a row of `comparison.rows` (or `bySource`, read the same
 * way), so a card, a bar and the table cannot disagree. Whether a change is
 * good is the row's `assessment`, from the metric's formula; nothing here
 * states a direction.
 */
export function ComparisonView({ comparison, currency }: { comparison: Comparison; currency: string }) {
  const row = (key: string) => comparison.rows.find((r) => r.key === key) ?? null;
  const names = {
    a: `Period A · ${formatRangeLabel(comparison.a.range)}`,
    b: `Period B · ${formatRangeLabel(comparison.b.range)}`,
  };
  const all = comparison.source === 'all';
  const contract = row('funded_volume_contract');

  const headline: { key: string; info: string; extra?: ReactNode }[] = [
    ...(comparison.paid ? [{ key: 'spend', info: 'Ad spend across every connected ad platform for the source, in each period.' }] : []),
    { key: 'leads', info: 'Leads created in each period.' },
    { key: 'approvals', info: 'Deals approved (UW approved, with an offer) in each period.' },
    { key: 'funded_deals', info: 'Deals funded in each period.' },
    {
      key: 'funded_volume',
      info: 'Funded amount on the deals funded in each period.',
      extra:
        contract && (contract.a.target || contract.b.target) ? (
          <ContractLine row={contract} currency={currency} />
        ) : undefined,
    },
    ...(comparison.paid
      ? [
          { key: 'cpa', info: 'Ad spend over approvals, each period over its own. All sources: every ad platform’s spend over every source’s approvals.' },
          { key: 'cpfd', info: 'Ad spend over funded deals, each period over its own. All sources: every ad platform’s spend over every source’s deals.' },
        ]
      : []),
  ];
  const cards = headline.map((h) => ({ ...h, row: row(h.key) })).filter((h): h is typeof h & { row: ComparisonRow } => h.row !== null);

  const funnel = comparison.funnel
    .map((s) => ({ step: s, count: row(s.row), conversion: s.conversion ? row(s.conversion) : null }))
    .filter((s): s is typeof s & { count: ComparisonRow } => s.count !== null);
  const costs = ['cpl', 'cpmql', 'cpa', 'cpfd'].map(row).filter((r): r is ComparisonRow => r !== null);
  const calls = ['speed', 'within5'].map(row).filter((r): r is ComparisonRow => r !== null);
  const sourceHeight = 48 + comparison.bySource.length * 44;

  return (
    <>
      {cards.map((c, i) => (
        <ComparisonKpi key={c.key} row={c.row} info={c.info} currency={currency} span={i < 4 ? 3 : 4} extra={c.extra} />
      ))}

      {funnel.length > 0 && (
        <Card span={12}>
          <CardHeader
            title="Funnel, side by side"
            subtitle="Each stage’s count in each period, and the conversion between stages"
            controls={<ExportButton datasets={['comparison']} />}
          />
          <CardBody>
            <PairedBars
              id="comparison-funnel"
              rows={funnel.map((f) => ({ label: f.step.label, a: f.count.a.value, b: f.count.b.value }))}
              names={names}
              format={{ kind: 'count' }}
              height={48 + funnel.length * 44}
              layout="horizontal-bars"
            />
            <ol className="mt-4 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
              {funnel
                .filter((f) => f.conversion)
                .map((f) => (
                  <li key={f.step.key} className="min-w-0 rounded-[8px] border border-border px-3 py-2">
                    <p className="truncate text-[12px] font-medium text-text-2">
                      {funnel[funnel.indexOf(f) - 1]?.step.label ?? ''} → {f.step.label}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-[13px] tabular">
                      <span className="font-semibold text-text">
                        A <Figure cell={f.conversion!.a} format="percent" currency={currency} />
                      </span>
                      <span className="text-text-2">
                        B <Figure cell={f.conversion!.b} format="percent" currency={currency} />
                      </span>
                    </p>
                    <ChangeLine row={f.conversion!} currency={currency} compact />
                  </li>
                ))}
            </ol>
          </CardBody>
        </Card>
      )}

      {comparison.paid && costs.length > 0 && (
        <Card span={comparison.bySource.length > 0 ? 6 : 12}>
          <CardHeader
            title="Cost comparison"
            subtitle="Ad spend over each period’s own counts"
            info={<InfoTip label="How the costs are drawn">A cost with nothing to divide by draws no bar; the line beneath says why.</InfoTip>}
            controls={<ExportButton datasets={['comparison']} />}
          />
          <CardBody>
            <PairedBars
              id="comparison-costs"
              rows={costs.map((r) => ({ label: r.label, a: r.a.value, b: r.b.value }))}
              names={names}
              format={{ kind: 'currency', currency }}
              height={220}
              layout="horizontal-bars"
            />
            <ul className="mt-3 grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-[12px] tabular text-text-3 sm:grid-cols-2">
              {costs.map((r) => (
                <li key={r.key} className="min-w-0">
                  {r.label}: A {basisText(r.a)} · B {basisText(r.b)}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {comparison.bySource.length > 0 && (
        <Card span={comparison.paid && costs.length > 0 ? 6 : 12}>
          <CardHeader
            title="Funded by source"
            subtitle="Funded deals and funded volume per source"
            controls={<ExportButton datasets={['comparison_sources']} />}
          />
          <CardBody className="grid min-w-0 gap-6">
            <div className="min-w-0">
              <p className="mb-2 text-[12px] font-semibold text-text-2">Funded deals</p>
              <PairedBars
                id="comparison-source-deals"
                rows={comparison.bySource.map((s) => ({ label: s.label, a: s.deals[0].value, b: s.deals[1].value }))}
                names={names}
                format={{ kind: 'count' }}
                height={sourceHeight}
                layout="horizontal-bars"
              />
            </div>
            <div className="min-w-0">
              <p className="mb-2 text-[12px] font-semibold text-text-2">Funded volume</p>
              <PairedBars
                id="comparison-source-volume"
                rows={comparison.bySource.map((s) => ({ label: s.label, a: s.volume[0].value, b: s.volume[1].value }))}
                names={names}
                format={{ kind: 'currency', currency }}
                height={sourceHeight}
                layout="horizontal-bars"
              />
            </div>
          </CardBody>
        </Card>
      )}

      {all && calls.map((r) => <ComparisonKpi key={r.key} row={r} currency={currency} span={6} info={callInfo(r.key)} />)}

      <Card span={12} id="comparison-table">
        <CardHeader
          title="All metrics"
          subtitle={`${comparison.rows.length} metrics · ${periodLine(comparison.a, 'A')} vs ${periodLine(comparison.b, 'B')}`}
          controls={<ExportButton datasets={['comparison']} />}
        />
        <details className="group border-t border-border">
          <summary className="cursor-pointer list-none px-5 py-3 text-[13px] font-semibold text-text marker:hidden">
            <span className="group-open:hidden">Show all metrics</span>
            <span className="hidden group-open:inline">Hide all metrics</span>
          </summary>
          <ComparisonTable comparison={comparison} currency={currency} bare />
        </details>
      </Card>
    </>
  );
}

const periodLine = (p: Comparison['a'], name: string) =>
  `${name} ${formatRangeLabel(p.range)} (${rangeLengthDays(p.range)} days${p.frozen ? ', frozen baseline' : ''})`;

const callInfo = (key: string) =>
  key === 'speed'
    ? 'The median time from a lead arriving to its first call, over leads that were called.'
    : 'The share of called leads whose first call came within five minutes.';

const basisText = (c: ComparisonCell) => (c.basis ? `based on ${formatCount(c.basis.n)} ${c.basis.noun}` : c.value === null ? '—' : '');

/** One headline figure: Period A large, Period B beneath, the change, a two-bar mini chart. */
function ComparisonKpi({
  row,
  info,
  currency,
  span,
  extra,
}: {
  row: ComparisonRow;
  info: string;
  currency: string;
  span: 3 | 4 | 6;
  extra?: ReactNode;
}) {
  const target = row.a.target ?? row.b.target;
  const sameTarget =
    row.a.target && row.b.target && row.a.target.low === row.b.target.low && row.a.target.high === row.b.target.high;
  return (
    <Card span={span} className="justify-between">
      <div className="px-5 pt-4">
        <div className="flex items-start justify-between gap-2">
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-text-2">
            {row.label}
            <InfoTip label={`How ${row.label} is measured`}>{info}</InfoTip>
          </p>
          <ExportButton datasets={['comparison']} />
        </div>
        {row.a.value === null ? (
          <p className="mt-1.5 flex items-center gap-2 text-[28px] font-semibold leading-[1.15] text-text-3">
            —
            {row.a.unmeasured ? <NotMeasuredBadge /> : null}
            {row.a.reason && <InfoTip label="Why there is no figure">{row.a.reason}</InfoTip>}
          </p>
        ) : (
          <p className="mt-1.5 text-[28px] font-semibold leading-[1.15] tabular text-text">{formatValue(row.a.value, row.format, currency)}</p>
        )}
        <p className="mt-0.5 flex items-center gap-1 text-[13px] tabular text-text-2">
          vs <Figure cell={row.b} format={row.format} currency={currency} /> in Period B
          {row.b.value === null && row.b.unmeasured && <NotMeasuredBadge className="ml-1" />}
        </p>
        <ChangeLine row={row} currency={currency} />
        {(row.a.basis || row.b.basis) && (
          <p className="mt-1 text-[12px] leading-snug tabular text-text-3">
            A {basisText(row.a)} · B {basisText(row.b)}
          </p>
        )}
        {target && (
          <p className="mt-1 text-[12px] leading-snug tabular text-text-2">
            {sameTarget || !row.a.target || !row.b.target
              ? targetText(target, currency)
              : `A ${targetText(row.a.target, currency).toLowerCase()} · B ${targetText(row.b.target, currency).toLowerCase()}`}
          </p>
        )}
        {extra}
      </div>
      <PairMeter row={row} />
    </Card>
  );
}

/**
 * The card's mini chart: Period A and Period B as two bars on one scale, each
 * labelled, so the comparison is drawn as well as stated. A period with no
 * figure draws no bar, never a zero-length one.
 */
function PairMeter({ row }: { row: ComparisonRow }) {
  const values = [row.a.value, row.b.value].filter((v): v is number => v !== null).map(Math.abs);
  const max = Math.max(...values, 0);
  const bar = (name: string, value: number | null, color: string) => (
    <div className="flex items-center gap-2">
      <span className="w-3 shrink-0 text-[11px] font-semibold text-text-3">{name}</span>
      <span className="h-2.5 min-w-0 flex-1 rounded-full bg-canvas">
        {value !== null && max > 0 && (
          <span className="block h-full rounded-full" style={{ width: `${Math.max((Math.abs(value) / max) * 100, 1.5)}%`, background: color }} />
        )}
      </span>
    </div>
  );
  return (
    <div className="mt-3 grid gap-1.5 px-5 pb-4" role="img" aria-label={`${row.label}: Period A against Period B`}>
      {bar('A', row.a.value, PERIOD_A)}
      {bar('B', row.b.value, PERIOD_B)}
    </div>
  );
}

/** The contract's own volume measure — lead vendors excluded — beside its target. */
function ContractLine({ row, currency }: { row: ComparisonRow; currency: string }) {
  const target = row.a.target ?? row.b.target;
  return (
    <p className="mt-1 text-[12px] leading-snug tabular text-text-2">
      Lead vendors excluded: A <Figure cell={row.a} format="money" currency={currency} /> · B{' '}
      <Figure cell={row.b} format="money" currency={currency} />
      {target && <> · {targetText(target, currency).toLowerCase()}</>}
    </p>
  );
}

/** A figure inline, or "—" with its reason. */
function Figure({ cell, format, currency }: { cell: ComparisonCell; format: ComparisonFormat; currency: string }) {
  if (cell.value === null) {
    return (
      <span className="inline-flex items-center gap-0.5 text-text-3">
        —{cell.reason && <InfoTip label="Why there is no figure">{cell.reason}</InfoTip>}
      </span>
    );
  }
  return <span>{format === 'percent' ? formatRate(cell.value) : formatValue(cell.value, format, currency)}</span>;
}

/** The change A − B with its sign, an arrow and the colour its metric gives it; then the change in per cent. */
function ChangeLine({ row, currency, compact = false }: { row: ComparisonRow; currency: string; compact?: boolean }) {
  if (row.change === null || row.assessment === null) {
    return (
      <p className={`${compact ? 'mt-0.5 text-[12px]' : 'mt-1 text-[13px]'} flex items-center gap-1 text-text-3`}>
        <Minus aria-hidden="true" className="h-3.5 w-3.5" />
        no change to compare
      </p>
    );
  }
  const Arrow = row.change > 0 ? ArrowUp : row.change < 0 ? ArrowDown : Minus;
  const sign = row.change > 0 ? '+' : row.change < 0 ? '−' : '±';
  const size = Math.abs(row.change);
  const amount =
    row.format === 'percent'
      ? `${(size * 100).toFixed(1)} pts`
      : row.format === 'points'
        ? `${size.toFixed(1)} pts`
        : formatValue(size, row.format, currency);
  const pct = row.pct === null || row.format === 'percent' ? null : `${row.pct > 0 ? '+' : row.pct < 0 ? '−' : '±'}${(Math.abs(row.pct) * 100).toFixed(1)}%`;
  return (
    <p className={`${compact ? 'mt-0.5 text-[12px]' : 'mt-1 text-[13px]'} flex flex-wrap items-center gap-1 tabular`}>
      <span className={`inline-flex items-center gap-0.5 font-semibold ${toneFor(row.assessment)}`}>
        <Arrow aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2.5} />
        {sign}
        {amount}
        {pct && <span className="font-medium"> ({pct})</span>}
      </span>
      {!compact && <span className="text-text-3">vs Period B</span>}
      <span className="sr-only">
        {row.assessment === 'ahead' ? 'an improvement' : row.assessment === 'shortfall' ? 'a regression' : 'no assessment'}
      </span>
    </p>
  );
}
