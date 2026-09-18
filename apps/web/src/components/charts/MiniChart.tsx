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
}: {
  points: MiniPoint[];
  variant?: 'area' | 'bars';
  height?: number;
  /** What the series shows, for the accessible description. */
  label: string;
}) {
  const s = scale(points);

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
  const described = `${label}: ${measured} of ${points.length} periods measured, from ${points[0]?.label} to ${points.at(-1)?.label}`;

  return variant === 'bars' ? (
    <Bars points={points} s={s} height={height} described={described} />
  ) : (
    <Area points={points} s={s} height={height} described={described} />
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
}: {
  points: MiniPoint[];
  s: Scale;
  height: number;
  described: string;
}) {
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
          <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
        </linearGradient>
      </defs>

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
              stroke="var(--color-primary)"
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
                fill="var(--color-primary)"
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
