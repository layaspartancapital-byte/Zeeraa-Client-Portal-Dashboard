/**
 * The 6px inline bar used for rate columns and coverage (spec v2 §6).
 *
 * `over` draws a second segment past 100% in `--primary-soft`, which is how the
 * delivery table shows over-delivery without letting the bar lie about the
 * fraction: the first 100% stays proportional and the excess is visibly extra.
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
      className={`flex h-1.5 w-full min-w-[48px] overflow-hidden rounded-full bg-primary-100 ${className}`}
    >
      <span
        className={`h-full rounded-full ${tone === 'warn' ? 'bg-warn' : 'bg-primary'}`}
        style={{ width: `${clamped * 100}%` }}
      />
      {over > 0 && (
        <span className="h-full bg-primary-soft" style={{ width: `${over * 100}%` }} />
      )}
    </span>
  );
}

/**
 * The compliance ring on the service-levels card. A ring rather than a bar
 * because it sits beside a written commitment rather than in a column of
 * comparable rates.
 */
export function Ring({
  value,
  label,
  size = 34,
}: {
  /** 0–1, or null where the rate has no measurement behind it. */
  value: number | null;
  label: string;
  size?: number;
}) {
  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const filled = value === null ? 0 : Math.max(0, Math.min(1, value)) * c;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      className="shrink-0"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--color-primary-100)"
        strokeWidth={stroke}
        strokeDasharray={value === null ? '2 3' : undefined}
      />
      {value !== null && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
    </svg>
  );
}
