import { formatCount, formatCurrency, formatDuration, formatRate, formatRangeLabel, formatTargetCurrency, rangeLengthDays } from '@zeeraa/core';
import { Card, CardHeader } from '@/components/ui/Card';
import { InfoTip } from '@/components/ui/InfoTip';
import { ExportButton } from '@/components/export/ExportScope';
import { toneFor } from '@/components/ui/delta-tone';
import type { Comparison } from '@/lib/comparison';
import type { ComparisonCell, ComparisonFormat, ComparisonRow } from '@/lib/comparison-rows';

/**
 * The Comparison table: every KPI as a row, Period A beside Period B, the
 * change and the change in per cent (30 October 2026).
 *
 * A figure a source does not have is "—" with its reason on hover, never 0.
 * The change is coloured by whether the metric improving means it going up or
 * down — `assessment`, from the metric's formula — and always carries its sign
 * and an arrow, so colour is never the only signal. A rate's change is in
 * percentage points.
 */
export function ComparisonTable({ comparison, currency }: { comparison: Comparison; currency: string }) {
  const sections = [...new Set(comparison.rows.map((r) => r.section))];
  const period = (p: Comparison['a'], name: string) =>
    `${name} · ${formatRangeLabel(p.range)} · ${rangeLengthDays(p.range)} days${p.frozen ? ' · frozen baseline' : ''}`;
  return (
    <Card span={12} id="comparison-table">
      <CardHeader
        title={comparison.sources.find((s) => s.key === comparison.source)?.label ?? 'All sources'}
        subtitle={`${period(comparison.a, 'A')}  vs  ${period(comparison.b, 'B')}`}
        controls={<ExportButton datasets={['comparison']} />}
      />
      <div className="scroll-x min-w-0 overflow-x-auto border-t border-border">
        <table className="w-full min-w-[720px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-[12px] font-semibold text-text-2">
              <th scope="col" className="px-5 py-2.5">Metric</th>
              <th scope="col" className="numeric px-3 py-2.5">Period A</th>
              <th scope="col" className="numeric px-3 py-2.5">Period B</th>
              <th scope="col" className="numeric px-3 py-2.5">Change</th>
              <th scope="col" className="numeric px-5 py-2.5">% change</th>
            </tr>
          </thead>
          {sections.map((section) => (
            <tbody key={section}>
              <tr className="border-b border-border bg-canvas">
                <th colSpan={5} scope="colgroup" className="px-5 py-2 text-left text-[12px] font-semibold uppercase tracking-wide text-text-3">
                  {section}
                </th>
              </tr>
              {comparison.rows
                .filter((r) => r.section === section)
                .map((row) => (
                  <tr key={row.key} className="border-b border-border last:border-b-0">
                    <th scope="row" className="px-5 py-2.5 text-left font-medium text-text">
                      {row.label}
                    </th>
                    <td className="numeric px-3 py-2.5 align-top">
                      <Value cell={row.a} format={row.format} currency={currency} />
                    </td>
                    <td className="numeric px-3 py-2.5 align-top">
                      <Value cell={row.b} format={row.format} currency={currency} />
                    </td>
                    <td className="numeric px-3 py-2.5 align-top">
                      <Change row={row} currency={currency} />
                    </td>
                    <td className="numeric px-5 py-2.5 align-top">
                      <Percent row={row} />
                    </td>
                  </tr>
                ))}
            </tbody>
          ))}
        </table>
      </div>
    </Card>
  );
}

export function formatValue(value: number, format: ComparisonFormat, currency: string): string {
  switch (format) {
    case 'money':
      return formatCurrency(value, currency);
    case 'percent':
      return formatRate(value);
    case 'points':
      return `${value.toFixed(1)}%`;
    case 'seconds':
      return formatDuration(value);
    case 'count':
      return formatCount(value);
    default:
      return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
}

function Value({ cell, format, currency }: { cell: ComparisonCell; format: ComparisonFormat; currency: string }) {
  const target =
    cell.target &&
    `Target ${
      cell.target.high !== null
        ? `${formatTargetCurrency(cell.target.low, currency)}–${formatTargetCurrency(cell.target.high, currency)}`
        : formatTargetCurrency(cell.target.low, currency)
    }`;
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      {cell.value === null ? (
        <span className="inline-flex items-center gap-1 text-text-3">
          —
          {cell.reason && <InfoTip label="Why there is no figure" align="end">{cell.reason}</InfoTip>}
        </span>
      ) : (
        <span className="tabular text-text">{formatValue(cell.value, format, currency)}</span>
      )}
      {cell.value !== null && cell.basis && (
        <span className="text-[12px] tabular text-text-3">
          Based on {formatCount(cell.basis.n)} {cell.basis.noun}
        </span>
      )}
      {target && <span className="text-[12px] tabular text-text-2">{target}</span>}
    </span>
  );
}

function Change({ row, currency }: { row: ComparisonRow; currency: string }) {
  if (row.change === null || row.assessment === null) return <span className="text-text-3">—</span>;
  const sign = row.change > 0 ? '+' : row.change < 0 ? '−' : '±';
  const arrow = row.change > 0 ? '↑' : row.change < 0 ? '↓' : '';
  const size = Math.abs(row.change);
  const text =
    row.format === 'percent'
      ? `${(size * 100).toFixed(1)} pts`
      : row.format === 'points'
        ? `${size.toFixed(1)} pts`
        : formatValue(size, row.format, currency);
  return (
    <span className={`tabular font-medium ${toneFor(row.assessment)}`}>
      {arrow && <span aria-hidden="true">{arrow} </span>}
      {sign}
      {text}
    </span>
  );
}

function Percent({ row }: { row: ComparisonRow }) {
  if (row.pct === null || row.assessment === null) return <span className="text-text-3">—</span>;
  const sign = row.pct > 0 ? '+' : row.pct < 0 ? '−' : '±';
  return (
    <span className={`tabular ${toneFor(row.assessment)}`}>
      {sign}
      {(Math.abs(row.pct) * 100).toFixed(1)}%
    </span>
  );
}
