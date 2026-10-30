import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { formatCount, formatRangeLabel, rangeLengthDays } from '@zeeraa/core';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { InfoTip } from '@/components/ui/InfoTip';
import { NotMeasuredBadge } from '@/components/ui/Badge';
import { toneFor } from '@/components/ui/delta-tone';
import { LazyPairedBars } from '@/components/charts/LazyPairedBars';
import { ExportButton } from '@/components/export/ExportScope';
import { ComparisonTable, formatValue, targetText } from '@/components/ComparisonTable';
import type { Comparison } from '@/lib/comparison';
import type { ComparisonCell, ComparisonFormat, ComparisonRow } from '@/lib/comparison-rows';

/**
 * The Comparison page, styled as Monthly performance (30 October 2026, the
 * second pass): compact headline cards, then tables — the funnel with its
 * conversions inline, the costs, funded by source — one small chart of funded
 * volume by source, the two call cards, and every metric folded at the bottom.
 * "Export everything" in the top bar, and "Export to Excel" on each table —
 * not on the headline or call cards.
 *
 * Every figure is a row of `comparison.rows` (or `bySource`, read the same
 * way), so a card and a table cannot disagree. Whether a change is good is
 * the row's `assessment`, from the metric's formula; nothing here states a
 * direction.
 */
export function ComparisonView({ comparison, currency }: { comparison: Comparison; currency: string }) {
  const row = (key: string) => comparison.rows.find((r) => r.key === key) ?? null;
  const all = comparison.source === 'all';
  const contract = row('funded_volume_contract');
  const periods = { a: formatRangeLabel(comparison.a.range), b: formatRangeLabel(comparison.b.range) };

  const headline: { key: string; info: string; extra?: ReactNode }[] = [
    ...(comparison.paid ? [{ key: 'spend', info: 'Ad spend across every connected ad platform for the source, in each period.' }] : []),
    { key: 'leads', info: 'Leads created in each period.' },
    { key: 'approvals', info: 'Deals approved (UW approved, with an offer) in each period.' },
    { key: 'funded_deals', info: 'Deals funded in each period.' },
    {
      key: 'funded_volume',
      info: 'Funded amount on the deals funded in each period.',
      extra: contract && (contract.a.target || contract.b.target) ? <ContractLine row={contract} currency={currency} /> : undefined,
    },
    ...(comparison.paid
      ? [
          { key: 'cpa', info: 'Ad spend over approvals, each period over its own. All sources: every ad platform’s spend over every source’s approvals.' },
          { key: 'cpfd', info: 'Ad spend over funded deals, each period over its own. All sources: every ad platform’s spend over every source’s deals.' },
        ]
      : []),
  ];
  const cards = headline.map((h) => ({ ...h, row: row(h.key) })).filter((h): h is typeof h & { row: ComparisonRow } => h.row !== null);

  // The funnel's stages, each preceded by the conversion into it.
  const funnelRows: { row: ComparisonRow; conversion: boolean }[] = [];
  let previous: string | null = null;
  for (const step of comparison.funnel) {
    const conversion = step.conversion ? row(step.conversion) : null;
    // Named by the two stages it joins, the MQL rate included.
    if (conversion) funnelRows.push({ row: { ...conversion, label: `${previous} → ${step.label}` }, conversion: true });
    previous = step.label;
    const count = row(step.row);
    if (count) funnelRows.push({ row: { ...count, label: step.label }, conversion: false });
  }
  const costs = ['cpl', 'cpmql', 'cpa', 'cpfd'].map(row).filter((r): r is ComparisonRow => r !== null);
  const showCosts = comparison.paid && costs.length > 0;
  const calls = ['speed', 'within5'].map(row).filter((r): r is ComparisonRow => r !== null);
  const deals = row('funded_deals');
  const volume = row('funded_volume');

  return (
    <>
      {cards.map((c, i) => (
        <CompactKpi key={c.key} row={c.row} info={c.info} currency={currency} span={i < 4 ? 3 : 4} extra={c.extra} />
      ))}

      {funnelRows.length > 0 && (
        <Card span={showCosts ? 6 : 12}>
          <CardHeader
            title="Funnel"
            subtitle="Each stage in each period, with the conversion into it"
            controls={<ExportButton datasets={['comparison_funnel']} />}
          />
          <PairTable head="Stage" periods={periods}>
            {funnelRows.map(({ row: r, conversion }) => (
              <PairRow key={r.key} row={r} currency={currency} minor={conversion} />
            ))}
          </PairTable>
        </Card>
      )}

      {showCosts && (
        <Card span={funnelRows.length > 0 ? 6 : 12} selfStart>
          <CardHeader
            title="Cost"
            subtitle="Ad spend over each period’s own counts"
            info={<InfoTip label="How the costs are read">A cost with nothing to divide by is “—”, with the reason on hover.</InfoTip>}
            controls={<ExportButton datasets={['comparison_cost']} />}
          />
          <PairTable head="Cost" periods={periods}>
            {costs.map((r) => (
              <PairRow key={r.key} row={r} currency={currency} />
            ))}
          </PairTable>
        </Card>
      )}

      {comparison.bySource.length > 0 && (
        <Card span={8}>
          <CardHeader
            title="Funded by source"
            subtitle="Funded deals and volume per source; the change is in volume"
            controls={<ExportButton datasets={['comparison_sources']} />}
          />
          <div className="scroll-x min-w-0 overflow-x-auto border-t border-border">
            <table className="w-full min-w-[620px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-[12px] font-semibold text-text-2">
                  <th scope="col" className="px-5 py-2.5">Source</th>
                  <th scope="col" className="numeric px-3 py-2.5">Deals A</th>
                  <th scope="col" className="numeric px-3 py-2.5">Deals B</th>
                  <th scope="col" className="numeric px-3 py-2.5">Volume A</th>
                  <th scope="col" className="numeric px-3 py-2.5">Volume B</th>
                  <th scope="col" className="numeric px-5 py-2.5">Change</th>
                </tr>
              </thead>
              <tbody>
                {comparison.bySource.map((s) => (
                  <tr key={s.key} className="border-b border-border transition-colors hover:bg-canvas">
                    <th scope="row" className="px-5 py-3 text-left font-medium text-text">{s.label}</th>
                    <td className="numeric px-3 py-3 text-text"><Figure cell={s.deals[0]} format="count" currency={currency} /></td>
                    <td className="numeric px-3 py-3 text-text-2"><Figure cell={s.deals[1]} format="count" currency={currency} /></td>
                    <td className="numeric px-3 py-3 text-text"><Figure cell={s.volume[0]} format="money" currency={currency} /></td>
                    <td className="numeric px-3 py-3 text-text-2"><Figure cell={s.volume[1]} format="money" currency={currency} /></td>
                    <td className="numeric px-5 py-3"><Change change={{ ...s.volumeChange, format: 'money' }} currency={currency} /></td>
                  </tr>
                ))}
              </tbody>
              {deals && volume && (
                <tfoot>
                  <tr className="border-t-2 border-border bg-canvas font-semibold">
                    <th scope="row" className="px-5 py-3 text-left text-text">All sources</th>
                    <td className="numeric px-3 py-3 text-text"><Figure cell={deals.a} format="count" currency={currency} /></td>
                    <td className="numeric px-3 py-3 text-text-2"><Figure cell={deals.b} format="count" currency={currency} /></td>
                    <td className="numeric px-3 py-3 text-text"><Figure cell={volume.a} format="money" currency={currency} /></td>
                    <td className="numeric px-3 py-3 text-text-2"><Figure cell={volume.b} format="money" currency={currency} /></td>
                    <td className="numeric px-5 py-3"><Change change={volume} currency={currency} /></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </Card>
      )}

      {comparison.bySource.length > 0 && (
        <Card span={4}>
          <CardHeader title="Funded volume by source" subtitle={`A ${periods.a} · B ${periods.b}`} />
          <CardBody>
            <LazyPairedBars
              id="comparison-source-volume"
              rows={comparison.bySource.map((s) => ({ label: s.label, a: s.volume[0].value, b: s.volume[1].value }))}
              names={{ a: 'Period A', b: 'Period B' }}
              format={{ kind: 'currency', currency }}
              height={36 + comparison.bySource.length * 34}
              layout="horizontal-bars"
            />
          </CardBody>
        </Card>
      )}

      {all && calls.map((r) => <CompactKpi key={r.key} row={r} currency={currency} span={6} info={callInfo(r.key)} />)}

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
          <ComparisonTable comparison={comparison} currency={currency} />
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

const basisText = (c: ComparisonCell) => (c.basis ? `${formatCount(c.basis.n)} ${c.basis.noun}` : null);

/** One headline figure, as Monthly performance's top cards: A, "vs B", the change. */
function CompactKpi({
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
  const basis = [basisText(row.a) && `A on ${basisText(row.a)}`, basisText(row.b) && `B on ${basisText(row.b)}`]
    .filter(Boolean)
    .join(' · ');
  return (
    <Card span={span} className="px-5 py-4">
      <p className="flex items-center gap-1.5 text-[13px] font-medium text-text-2">
        {row.label}
        <InfoTip label={`How ${row.label} is measured`}>{info}</InfoTip>
      </p>
      {row.a.value === null ? (
        <p className="mt-1.5 flex items-center gap-2 text-[24px] font-semibold leading-[1.15] text-text-3">
          —{row.a.unmeasured && <NotMeasuredBadge />}
          {row.a.reason && <InfoTip label="Why there is no figure">{row.a.reason}</InfoTip>}
        </p>
      ) : (
        <p className="mt-1.5 text-[24px] font-semibold leading-[1.15] tabular text-text">{formatValue(row.a.value, row.format, currency)}</p>
      )}
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] tabular">
        <Change change={row} currency={currency} />
        <span className="inline-flex items-center gap-1 text-text-3">
          vs <Figure cell={row.b} format={row.format} currency={currency} />
        </span>
      </p>
      {basis && <p className="mt-1 text-[12px] leading-snug tabular text-text-3">Based on {basis}</p>}
      {target && (
        <p className="mt-0.5 text-[12px] leading-snug tabular text-text-2">
          {sameTarget || !row.a.target || !row.b.target
            ? targetText(target, currency)
            : `A ${targetText(row.a.target, currency).toLowerCase()} · B ${targetText(row.b.target, currency).toLowerCase()}`}
        </p>
      )}
      {extra}
    </Card>
  );
}

/** The contract's own volume measure — lead vendors excluded — beside its target. */
function ContractLine({ row, currency }: { row: ComparisonRow; currency: string }) {
  const target = row.a.target ?? row.b.target;
  return (
    <p className="mt-0.5 text-[12px] leading-snug tabular text-text-2">
      Excl. lead vendors <Figure cell={row.a} format="money" currency={currency} />
      {target && <> · {targetText(target, currency).toLowerCase()}</>}
    </p>
  );
}

/** A table with A, B and the change, styled as Monthly performance's "All platforms". */
function PairTable({ head, periods, children }: { head: string; periods: { a: string; b: string }; children: ReactNode }) {
  return (
    <div className="scroll-x min-w-0 overflow-x-auto border-t border-border">
      <table className="w-full min-w-[340px] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border text-left text-[12px] font-semibold text-text-2">
            <th scope="col" className="px-5 py-2.5">{head}</th>
            <th scope="col" className="numeric px-3 py-2.5" title={periods.a}>A</th>
            <th scope="col" className="numeric px-3 py-2.5" title={periods.b}>B</th>
            <th scope="col" className="numeric px-5 py-2.5">Change</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function PairRow({ row, currency, minor = false }: { row: ComparisonRow; currency: string; minor?: boolean }) {
  const pad = minor ? 'py-1.5' : 'py-3';
  return (
    <tr className={`border-b border-border transition-colors last:border-b-0 hover:bg-canvas ${minor ? 'text-[12px]' : ''}`}>
      <th scope="row" className={`text-left ${minor ? `${pad} pl-8 pr-3 font-normal text-text-3` : `${pad} px-5 font-medium text-text`}`}>
        {row.label}
      </th>
      <td className={`numeric px-3 ${pad} ${minor ? 'text-text-2' : 'text-text'}`}>
        <Figure cell={row.a} format={row.format} currency={currency} />
      </td>
      <td className={`numeric px-3 ${pad} text-text-2`}>
        <Figure cell={row.b} format={row.format} currency={currency} />
      </td>
      <td className={`numeric px-5 ${pad}`}>
        <Change change={row} currency={currency} />
      </td>
    </tr>
  );
}

/** A figure inline, or "—" with its reason. */
function Figure({ cell, format, currency }: { cell: ComparisonCell; format: ComparisonFormat; currency: string }) {
  if (cell.value === null) {
    return (
      <span className="inline-flex items-center gap-0.5 text-text-3">
        —{cell.reason && <InfoTip label="Why there is no figure" align="end">{cell.reason}</InfoTip>}
      </span>
    );
  }
  return <span className="tabular">{formatValue(cell.value, format, currency)}</span>;
}

/** The change A − B: sign, arrow and the colour its metric gives it, then the change in per cent. */
function Change({
  change,
  currency,
}: {
  change: Pick<ComparisonRow, 'change' | 'pct' | 'assessment' | 'format'>;
  currency: string;
}) {
  if (change.change === null || change.assessment === null) return <span className="text-text-3">—</span>;
  const Arrow = change.change > 0 ? ArrowUp : change.change < 0 ? ArrowDown : Minus;
  const sign = change.change > 0 ? '+' : change.change < 0 ? '−' : '±';
  const size = Math.abs(change.change);
  const amount =
    change.format === 'percent'
      ? `${(size * 100).toFixed(1)} pts`
      : change.format === 'points'
        ? `${size.toFixed(1)} pts`
        : formatValue(size, change.format, currency);
  const pct =
    change.pct === null || change.format === 'percent' || change.format === 'points'
      ? null
      : `${change.pct > 0 ? '+' : change.pct < 0 ? '−' : '±'}${(Math.abs(change.pct) * 100).toFixed(1)}%`;
  return (
    <span className={`inline-flex items-center gap-0.5 whitespace-nowrap font-semibold tabular ${toneFor(change.assessment)}`}>
      <Arrow aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2.5} />
      {sign}
      {amount}
      {pct && <span className="font-medium"> ({pct})</span>}
      <span className="sr-only">
        {change.assessment === 'ahead' ? ', an improvement' : change.assessment === 'shortfall' ? ', a regression' : ''}
      </span>
    </span>
  );
}
