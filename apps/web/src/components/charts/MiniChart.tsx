/**
 * The mini chart every KPI card carries (spec v2 §6).
 *
 * Drawn as inline SVG rather than through the charting library: at 60px tall
 * with no axes, no legend and no tooltip there is nothing a chart library adds
 * except a client bundle, and these render on the server with the figure they
 * belong to.
 *
 * Two rules it does not break:
 *
 *   - A point with no measurement behind it is a gap, never a zero. A bar that
 *     is absent and a bar at zero are opposite claims, and the months before
 *     ingestion began are the first kind.
 *   - A provisional tail — the trailing buckets that platforms are still
 *     restating — is drawn dashed and hollow. The card header carries the badge;
 *     the chart carries the texture.
 */

export type MiniPoint = {
  label: string;
  /** Null where nothing was measured for this bucket. Never coerce to 0. */
  value: number | null;
  provisional?: boolean;
};

/**
 * How the measured line is drawn.
 *
 * `primary` is the default and says nothing about whether the movement is good.
 * `ahead` and `shortfall` colour it by the metric's own improvement direction —
 * a falling cost per funded deal is green while it points down — and are only
 * ever passed a value derived from `seriesTrend`, never from the direction of
 * travel on its own.
 */
export type SeriesTone = 'primary' | 'ahead' | 'shortfall';

const STROKE: Record<SeriesTone, string> = {
  primary: 'var(--color-primary)',
  ahead: 'var(--color-up)',
  shortfall: 'var(--color-down)',
};

const W = 200;
const H = 56;

function scale(points: MiniPoint[]) {
  const values = points.filter((p) => p.value !== null).map((p) => p.value!);
  if (values.length === 0) return null;
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || Math.abs(max) || 1;
  return { max, min, span };
}

export function MiniChart({
  points,
  variant = 'area',
  height = H,
  label,
  tone = 'primary',
  target,
  targetLabel = 'target',
}: {
  points: MiniPoint[];
  variant?: 'area' | 'bars';
  height?: number;
  /** What the series shows, for the accessible description. */
  label: string;
  tone?: SeriesTone;
  /**
   * A contracted curve drawn behind the measured one, bucket for bucket.
   *
   * Same length and same order as `points` — a target for a month nobody
   * measured is still a target and still draws, which is the whole point of
   * showing the two together. Null entries are months the ramp does not cover,
   * and they break the line rather than being bridged.
   */
  target?: (number | null)[];
  targetLabel?: string;
}) {
  // Scaled over both series together, so the gap between them is the distance
  // on screen. Scaling to the measured line alone would put the target off the
  // top of the chart and draw a flat line at the edge.
  const s = scale(
    target ? [...points, ...target.map((value, i) => ({ label: `t${i}`, value }))] : points,
  );

  if (!s || points.length === 0) {
    return (
      <div
        role="img"
        aria-label={`${label}: no history yet`}
        className="flex w-full items-end"
        style={{ height }}
      >
        {/* A dashed baseline: this is an empty chart, not a missing one. */}
      <div className="w-full border-t border-dashed border-mark" />
      </div>
    );
  }

  const measured = points.filter((p) => p.value !== null).length;
  const targeted = target?.filter((v) => v !== null).length ?? 0;
  const described =
    `${label}: ${measured} of ${points.length} periods measured, ` +
    `from ${points[0]?.label} to ${points.at(-1)?.label}` +
    (targeted > 0 ? `, against a ${targetLabel} in ${targeted} of them` : '');

  return variant === 'bars' ? (
    <Bars points={points} s={s} height={height} described={described} />
  ) : (
    <Area points={points} s={s} height={height} described={described} tone={tone} target={target} />
  );
}

type Scale = NonNullable<ReturnType<typeof scale>>;

function y(value: number, s: Scale) {
  // 3px of headroom top and bottom so a peak is not clipped by the stroke.
  return 3 + (1 - (value - s.min) / s.span) * (H - 6);
}

function x(i: number, n: number) {
  return n <= 1 ? W / 2 : (i / (n - 1)) * W;
}

function Area({
  points,
  s,
  height,
  described,
  tone = 'primary',
  target,
}: {
  points: MiniPoint[];
  s: Scale;
  height: number;
  described: string;
  tone?: SeriesTone;
  target?: (number | null)[];
}) {
  const stroke = STROKE[tone];
  // Contiguous runs of measured points. A gap breaks the line rather than
  // being bridged, because bridging invents the months nobody looked at.
  const runs: { i: number; p: MiniPoint }[][] = [];
  let run: { i: number; p: MiniPoint }[] = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push({ i, p });
    }
  });
  if (run.length) runs.push(run);

  const id = `mini-${described.length}-${points.length}`;

  // The contracted curve, in the same runs-with-gaps form as the measured one.
  const targetRuns: { i: number; v: number }[][] = [];
  if (target) {
    let tRun: { i: number; v: number }[] = [];
    target.forEach((v, i) => {
      if (v === null) {
        if (tRun.length) targetRuns.push(tRun);
        tRun = [];
      } else {
        tRun.push({ i, v });
      }
    });
    if (tRun.length) targetRuns.push(tRun);
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={described}
      className="w-full"
      style={{ height }}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.18" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Drawn first, so the measured line sits on top of it: the target is the
          reference and the measurement is the subject. Dashed and in the muted
          mark colour — it is a commitment, not something anybody observed. */}
      {targetRuns.map((r, ri) => (
        <path
          key={`t${ri}`}
          d={`M ${r.map(({ i, v }) => `${x(i, points.length)},${y(v, s)}`).join(' L ')}`}
          fill="none"
          stroke="var(--color-mark)"
          strokeWidth={1.5}
          strokeDasharray="3 3"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}

      {runs.map((r, ri) => {
        const line = r.map(({ i, p }) => `${x(i, points.length)},${y(p.value!, s)}`).join(' L ');
        const first = x(r[0]!.i, points.length);
        const last = x(r.at(-1)!.i, points.length);
        const provisional = r.every(({ p }) => p.provisional);
        return (
          <g key={ri}>
            {r.length > 1 && (
              <path d={`M ${line} L ${last},${H} L ${first},${H} Z`} fill={`url(#${id})`} />
            )}
            <path
              d={`M ${line}`}
              fill="none"
              stroke={stroke}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={provisional ? '4 3' : undefined}
              vectorEffect="non-scaling-stroke"
            />
            {r.length === 1 && (
              <circle
                cx={first}
                cy={y(r[0]!.p.value!, s)}
                r={2.5}
                fill={stroke}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Bars({
  points,
  s,
  height,
  described,
}: {
  points: MiniPoint[];
  s: Scale;
  height: number;
  described: string;
}) {
  const n = points.length;
  const slot = W / n;
  const gap = Math.min(4, slot * 0.28);
  const bw = Math.max(2, slot - gap);
  const zero = y(0, s);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={described}
      className="w-full"
      style={{ height }}
    >
      {points.map((p, i) => {
        if (p.value === null) return null;
        const top = y(p.value, s);
        const h = Math.max(1.5, Math.abs(zero - top));
        return (
          <rect
            key={p.label + i}
            x={i * slot + gap / 2}
            y={Math.min(top, zero)}
            width={bw}
            height={h}
            rx={1.5}
            fill={p.provisional ? 'var(--color-primary-soft)' : 'var(--color-primary)'}
          />
        );
      })}
    </svg>
  );
}
