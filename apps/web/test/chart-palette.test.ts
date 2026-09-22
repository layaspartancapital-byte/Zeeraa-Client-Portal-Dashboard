import { describe, expect, it } from 'vitest';
import { SERIES, PLOT, PLOT_SOFT, TEXT_2, TEXT_3, UNATTRIBUTED, UP, DOWN } from '../src/components/charts/palette';

/**
 * The chart palette's promises, re-derived rather than restated.
 *
 * Every number in `chart-kit`'s comment is computed here, because the palette
 * was replaced for three failures that no one would ever see by looking: a
 * series under 3:1, a series the same colour as "not measured", and two series
 * that are identical under deuteranopia. All three shipped for weeks in a
 * palette that looked perfectly fine.
 */
const CANVAS = '#F5F7FB';
const SURFACE = '#FFFFFF';
const WARN = '#F79009';
const GOLD = '#C9A227';

type RGB = [number, number, number];
const rgb = (hex: string): RGB => {
  const c = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255) as RGB;
};
const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map(linear) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

function lab(hex: string): RGB {
  const [r, g, b] = rgb(hex).map(linear) as RGB;
  const X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const deltaE = (a: string, b: string) =>
  Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]!));

/** Brettel/Viénot-style simulation, on linear RGB through LMS. */
function simulate(hex: string, kind: 'protan' | 'deutan' | 'tritan'): string {
  const [r, g, b] = rgb(hex).map(linear) as RGB;
  const L = 0.31399022 * r + 0.63951294 * g + 0.04649755 * b;
  const M = 0.15537241 * r + 0.75789446 * g + 0.08670142 * b;
  const S = 0.01775239 * r + 0.10944209 * g + 0.87256922 * b;
  const [L2, M2, S2] =
    kind === 'protan'
      ? [1.05118294 * M - 0.05116099 * S, M, S]
      : kind === 'deutan'
        ? [L, 0.9513092 * L + 0.04866992 * S, S]
        : [L, M, -0.86744736 * L + 1.86727089 * M];
  const out = [
    5.47221206 * L2 - 4.6419601 * M2 + 0.16963708 * S2,
    -1.1252419 * L2 + 2.29317094 * M2 - 0.1678952 * S2,
    0.02980165 * L2 - 0.19318073 * M2 + 1.16364789 * S2,
  ].map((v) => {
    const c = Math.min(1, Math.max(0, v));
    const g2 = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(g2 * 255)
      .toString(16)
      .padStart(2, '0');
  });
  return `#${out.join('')}`;
}

const pairs = <T,>(xs: readonly T[]): [T, T][] =>
  xs.flatMap((a, i) => xs.slice(i + 1).map((b) => [a, b] as [T, T]));

describe('every series is visible', () => {
  it.each([...SERIES])('%s clears 3:1 on the canvas and the card', (hex) => {
    // A series is a graphical object, not text: WCAG 1.4.11, 3:1. The legend
    // writes its label in `--text-2` beside a swatch rather than in the series
    // colour, which is what keeps this at 3 rather than 4.5.
    expect(ratio(hex, CANVAS)).toBeGreaterThanOrEqual(3);
    expect(ratio(hex, SURFACE)).toBeGreaterThanOrEqual(3);
  });

  it('keeps the plot colours visible too', () => {
    expect(ratio(PLOT, CANVAS)).toBeGreaterThanOrEqual(3);
    expect(ratio(PLOT_SOFT, CANVAS)).toBeGreaterThanOrEqual(3);
  });
});

describe('every series stays distinguishable', () => {
  it.each(['protan', 'deutan', 'tritan', 'normal'] as const)(
    'no two series collapse under %s vision',
    (kind) => {
      const seen = kind === 'normal' ? [...SERIES] : SERIES.map((h) => simulate(h, kind));
      const closest = Math.min(...pairs(seen).map(([a, b]) => deltaE(a, b)));
      // The old palette was 6.6 here under deuteranopia, in the two slots that
      // hold Google Ads and Meta Ads.
      expect(closest).toBeGreaterThanOrEqual(20);
    },
  );

  it('keeps the unattributed grey out of the categorical set', () => {
    // Deals no channel can claim are a population, not a channel. If the grey
    // drifted into the palette's range the chart would undo what the table's
    // separate row group establishes.
    for (const hex of SERIES) expect(deltaE(hex, UNATTRIBUTED)).toBeGreaterThan(20);
  });
});

describe('colour keeps meaning what it means', () => {
  it('never draws a channel in a direction colour', () => {
    // A channel that renders green looks like good news about itself.
    for (const hex of SERIES) {
      expect(deltaE(hex, UP)).toBeGreaterThan(40);
      expect(deltaE(hex, DOWN)).toBeGreaterThan(40);
    }
  });

  it('never draws a channel in the reserved interface colours', () => {
    for (const hex of SERIES) {
      expect(deltaE(hex, WARN)).toBeGreaterThan(30);
      expect(deltaE(hex, GOLD)).toBeGreaterThan(30);
    }
  });

  it('leaves the direction colours themselves alone', () => {
    // Rising cost is red and falling is green, whatever the brand does. These
    // two are load-bearing and the rebrand does not get a vote.
    expect(UP).toBe('#12B76A');
    expect(DOWN).toBe('#F04438');
  });
});

describe('text in and around a plot', () => {
  it('holds AA for axis and legend labels, which are type', () => {
    expect(ratio(TEXT_3, CANVAS)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(TEXT_2, CANVAS)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the plot palette is separate from the control palette', () => {
  it('does not lead with the interface blue', () => {
    // `--color-primary` dresses buttons and links. If the two ever converge,
    // restyling a control silently repaints every chart.
    expect(PLOT).not.toBe('#3B5BDB');
    expect(deltaE(PLOT, '#3B5BDB')).toBeGreaterThan(30);
  });

  it('separates a provisional bar from an empty baseline', () => {
    expect(deltaE(PLOT_SOFT, UNATTRIBUTED)).toBeGreaterThan(18);
    expect(deltaE(PLOT_SOFT, PLOT)).toBeGreaterThan(18);
  });
});
