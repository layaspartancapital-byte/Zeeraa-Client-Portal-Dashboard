import type { RampMetricKey } from '@zeeraa/core';
import { Card, CardHeader } from '@/components/ui/Card';
import { monthName, renderer, targetRenderer, type RampPanel } from '@/components/RampCard';
import { RAMP_TABLE_COLUMNS, type RampTableCell, type RampTableRow } from '@/lib/ramp-panels';

/**
 * The engagement ramp as one month-by-month table: each figure against its
 * target with a ✓ or "behind", the baseline months as actuals only. No
 * legend, basis line or footnote — the words in the cells are the key.
 */
export function RampTable({
  channel,
  rows,
  formats,
  valueLabel,
}: {
  channel: string;
  rows: RampTableRow[];
  formats: Record<RampMetricKey, RampPanel['format']>;
  valueLabel: string;
}) {
  const baseline = rows.filter((r) => r.rampLabel === null);
  const engagement = rows.length - baseline.length;
  const span =
    baseline.length === 0
      ? ''
      : `Baseline ${monthName(baseline[0]!.month).split(' ')[0]}–${monthName(baseline.at(-1)!.month)}, then `;
  return (
    <Card span={12}>
      <CardHeader title="Engagement ramp" subtitle={`${channel} · ${span}M1–M${engagement} against target`} />
      <div className="scroll-x min-w-0 overflow-x-auto border-t border-border">
        <table className="w-full min-w-[760px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-[12px] font-semibold text-text-2">
              <th scope="col" className="px-5 py-2.5">Month</th>
              {RAMP_TABLE_COLUMNS.map((c) => (
                <th key={c.metric} scope="col" className="numeric px-3 py-2.5">
                  {c.label(valueLabel)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={row.month}
                className={`border-b border-border last:border-b-0 ${
                  row.rampLabel !== null && rows[i - 1]?.rampLabel === null ? 'border-t-2 border-t-border' : ''
                }`}
              >
                <th scope="row" className="whitespace-nowrap px-5 py-2.5 text-left font-medium text-text">
                  {monthName(row.month)}
                  <span className="block text-[12px] font-normal text-text-3">
                    {row.rampLabel ?? 'baseline'}
                    {row.inProgress ? ' · month to date' : ''}
                  </span>
                </th>
                {RAMP_TABLE_COLUMNS.map((c) => (
                  <td key={c.metric} className="numeric px-3 py-2.5 align-top">
                    <Cell cell={row.cells[c.metric]} format={formats[c.metric]} future={row.future} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Cell({ cell, format, future }: { cell: RampTableCell; format: RampPanel['format']; future: boolean }) {
  const render = renderer({ format } as RampPanel);
  const renderTarget = targetRenderer({ format } as RampPanel);
  const target = cell.target === null ? null : renderTarget(cell.target);

  if (future) {
    return <span className="text-[12px] tabular text-text-3">{target ? `Target ${target}` : '—'}</span>;
  }

  const actual = cell.actual;
  const figure =
    actual?.value != null ? (
      <span className="tabular text-text">{render(actual.value)}</span>
    ) : (
      <span className="text-text-3" title={actual?.reason ?? undefined}>
        {actual?.empty ? actual.reason?.replace(/\.$/, '') : '—'}
      </span>
    );

  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      {figure}
      {target && (
        <span className="text-[12px] tabular text-text-3">
          of {target} <Verdict cell={cell} />
        </span>
      )}
    </span>
  );
}

function Verdict({ cell }: { cell: RampTableCell }) {
  const v = cell.verdict;
  if (!v) return null;
  switch (v.state) {
    case 'on_target':
      return (
        <span className="font-semibold text-text-2">
          <span aria-hidden="true">✓</span>
          <span className="sr-only">on target</span>
        </span>
      );
    case 'behind':
      return <span className="font-semibold text-down-text">behind</span>;
    case 'over':
    case 'under':
      return <span className="text-text-2">{v.state}</span>;
    default:
      return null;
  }
}
