import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { InfoTip } from '@/components/ui/InfoTip';
import { NotMeasuredBadge, ProvisionalBadge } from '@/components/ui/Badge';
import { MiniChart, type MiniPoint } from '@/components/charts/MiniChart';

/**
 * The KPI card (spec v2 §6).
 *
 * Label → figure → delta → one line of context → mini chart. Every one of them
 * has a mini chart; where there is not enough history it draws the buckets that
 * exist and leaves the rest blank rather than inventing a shape.
 *
 * Two states, and the second is the reason the component exists rather than a
 * `<div>` at each call site:
 *
 *   `measured`     — a figure with a resolvable source.
 *   `notMeasured`  — no measurement, rendered as an amber badge and one muted
 *                    line, with the dependency in the ⓘ. Never a zero. A zero
 *                    is a measurement, and "nobody stamps this timestamp in the
 *                    CRM" is the opposite of one.
 */
export function KpiCard({
  label,
  value,
  delta,
  context,
  points,
  info,
  variant = 'area',
  provisional = false,
  notMeasured,
  span = 3,
}: {
  label: string;
  /** Formatted. Null puts the card into its not-measured state. */
  value: string | null;
  delta?: ReactNode;
  /** One line, 13px muted. Never two. */
  context?: ReactNode;
  points: MiniPoint[];
  info?: ReactNode;
  variant?: 'area' | 'bars';
  provisional?: boolean;
  /** Required when `value` is null: the one line that replaces the figure. */
  notMeasured?: string;
  span?: 3 | 4 | 6;
}) {
  return (
    <Card span={span} className="justify-between">
      <div className="px-5 pt-4">
        <div className="flex items-start justify-between gap-2">
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-text-2">
            {label}
            {info && <InfoTip label={`How ${label} is measured`}>{info}</InfoTip>}
          </p>
          {provisional && value !== null && <ProvisionalBadge />}
          {value === null && <NotMeasuredBadge />}
        </div>

        {value === null ? (
          <p className="mt-2 text-[13px] leading-snug text-text-3">{notMeasured}</p>
        ) : (
          <p className="mt-1.5 text-[28px] font-semibold leading-[1.15] tabular text-text">
            {value}
          </p>
        )}

        {value !== null && delta && <div className="mt-1">{delta}</div>}
        {/* A div, not a paragraph: the cost-per-deal coverage line is itself a
            paragraph with an ⓘ in it, and a <p> inside a <p> is invalid HTML
            that React resolves by silently restructuring the DOM. */}
        {context && <div className="mt-1 text-[13px] leading-snug text-text-2 tabular">{context}</div>}
      </div>

      <div className="mt-3 px-1 pb-1">
        <MiniChart points={points} variant={variant} label={label} height={56} />
      </div>
    </Card>
  );
}
