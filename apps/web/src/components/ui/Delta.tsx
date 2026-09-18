import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { delta, formatDelta, type ImprovementDirection } from '@zeeraa/core';

/**
 * A change, with its sign, an arrow and a colour — in that order of importance.
 *
 * Colour comes last and is derived from the metric's `improvement_direction`,
 * never from the direction of travel: a falling cost per funded deal is an
 * improvement and renders green while it points down. Where no metric declares
 * a direction — paid media spend is the honest example, since spending less is
 * not an achievement and spending more is not a failure — `direction` is null
 * and the delta renders in `--text-2` with its sign and arrow intact.
 */
export function Delta({
  current,
  baseline,
  direction,
  comparison = 'vs previous period',
  unavailable = 'no comparable previous period',
  className = '',
}: {
  current: number;
  /**
   * Null where the comparison cannot be made — the baseline period predates
   * ingestion, or nothing was measured in it. The card renders the reason
   * rather than a percentage: a baseline of nearly nothing produces a change of
   * thousands of percent, which is arithmetically right and reads as
   * performance.
   */
  baseline: number | null;
  /** Null renders neutrally: no metric in configuration claims a direction. */
  direction: ImprovementDirection | null;
  comparison?: string;
  /** Why there is no comparison, when there is none. */
  unavailable?: string;
  className?: string;
}) {
  if (baseline === null) return <NoDelta reason={unavailable} />;

  const d = delta(current, baseline, direction ?? 'up');
  // A baseline of zero has no proportional change to report. "First measurement
  // in the record" and "up 100%" are different statements.
  if (d.relative === null) return <NoDelta reason="none in the previous period" />;
  const assessment = direction === null ? 'level' : d.assessment;
  // The text variants, not the fill tokens: the spec's green is 2.6:1 on white
  // and will not carry type.
  const tone =
    assessment === 'ahead'
      ? 'text-up-text'
      : assessment === 'shortfall'
        ? 'text-down-text'
        : 'text-text-2';
  const Arrow = d.sign === '+' ? ArrowUp : d.sign === '−' ? ArrowDown : Minus;

  return (
    <p className={`flex flex-wrap items-center gap-1 text-[13px] tabular ${className}`}>
      <span className={`inline-flex items-center gap-0.5 font-semibold ${tone}`}>
        <Arrow aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2.5} />
        {formatDelta(d)}
      </span>
      <span className="text-text-3">{comparison}</span>
      <span className="sr-only">
        {direction === null
          ? 'no improvement direction is configured for this metric, so this change is reported without an assessment'
          : assessment === 'ahead'
            ? 'an improvement'
            : assessment === 'shortfall'
              ? 'a regression'
              : 'unchanged'}
      </span>
    </p>
  );
}

/** The delta line when the comparison period has no measurement to compare to. */
export function NoDelta({ reason = 'no comparable previous period' }: { reason?: string }) {
  return (
    <p className="flex items-center gap-1 text-[13px] text-text-3">
      <Minus aria-hidden="true" className="h-3.5 w-3.5" />
      {reason}
    </p>
  );
}
