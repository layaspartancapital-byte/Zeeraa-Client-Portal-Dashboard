/**
 * The 6px inline bar used for rate columns and coverage (spec v2 §6).
 *
 * `over` draws a second segment past 100% in `--color-plot-soft`, which is how
 * a figure past its target renders without letting the bar lie about the
 * fraction: the first 100% stays proportional and the excess is visibly extra.
 *
 * Drawn in the plot palette rather than the control palette. **A bar in a table
 * is data, and data is ink** — `--color-primary` dresses the things a person
 * clicks. The two were the same colour until the rebrand, which is exactly how
 * a distinction like this goes unnoticed.
 */
export function Progress({
  value,
  label,
  tone = 'primary',
  className = '',
}: {
  /** 0–1. Values above 1 draw the excess in the soft tone. */
  value: number;
  /** Read out to assistive technology in place of the bar. */
  label: string;
  tone?: 'primary' | 'warn';
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(1, value));
  const over = Math.max(0, Math.min(1, value - 1));

  return (
    <span
      role="img"
      aria-label={label}
      className={`flex h-1.5 w-full min-w-[48px] overflow-hidden rounded-full bg-plot-track ${className}`}
    >
      <span
        className={`h-full rounded-full ${tone === 'warn' ? 'bg-warn' : 'bg-plot'}`}
        style={{ width: `${clamped * 100}%` }}
      />
      {over > 0 && (
        <span className="h-full bg-plot-soft" style={{ width: `${over * 100}%` }} />
      )}
    </span>
  );
}
