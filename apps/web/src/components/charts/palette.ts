/**
 * The chart palette, and nothing that renders.
 *
 * A plain module rather than part of `chart-kit` so the values can be imported
 * and checked without pulling in a client component —
 * `apps/web/test/chart-palette.test.ts` re-derives every contrast ratio and
 * every colour-blind separation from here. The palette is data about the
 * product's meanings; keeping it out of a `.tsx` is what makes it testable.
 */

/**
 * The ordered categorical palette. Assigned by identity, never by rank.
 *
 * Reworked 22 September 2026 with the rebrand, and the aesthetic was the
 * smaller half of the reason. Spec v2's palette had three failures that only
 * arithmetic finds:
 *
 *   - `#06B6D4`, `#F59E0B` and `#10B981` were **2.26, 2.00 and 2.37** against
 *     the canvas, under the 3:1 WCAG 1.4.11 asks of a graphical object.
 *   - `#F59E0B` was dE 8.8 from `--color-warn` and `#10B981` dE 11.6 from
 *     `--color-up`, so a channel could be drawn in very nearly the colour that
 *     means "not measured", or the one that means "improving".
 *   - `#3B5BDB` and `#7C3AED` were **dE 6.6 apart under deuteranopia** — the
 *     same colour, in the two slots every comparison puts side by side.
 *
 * **Red, green and gold are spoken for**, by direction and by the nav accent,
 * and they are excluded by *hue* rather than by distance: a dark sage is far
 * from `--color-up` in dE and still reads as good news on a bar. What is left
 * is the teal-blue-violet-plum arc, which is too narrow for six hues to survive
 * colour blindness — so **this palette separates by lightness as much as by
 * hue**, which is what makes it hold up when the hues collapse.
 *
 * Worst-case separation is dE 23.8 across normal vision, protanopia,
 * deuteranopia and tritanopia, against 6.6 before. Every entry clears 3:1.
 * `apps/web/test/chart-palette.test.ts` re-derives all of it.
 */
export const SERIES = [
  '#242B3A',
  '#661F75',
  '#3985FF',
  '#3641AB',
  '#8079C0',
  '#9C6B89',
] as const;

/**
 * A plot with one series, and the lead categorical slot.
 *
 * Ink rather than the interface's blue. `--color-primary` still belongs to
 * buttons, links and focus rings, which are controls rather than data: a plot
 * area borrows nothing from the control palette, so changing one cannot quietly
 * restyle the other.
 */
export const PLOT = SERIES[0];
/** Provisional bars and the "if every unattributed deal were this one" range. */
export const PLOT_SOFT = '#5F6B85';
export const BORDER = '#E6EAF2';
export const TEXT = '#101828';
export const TEXT_2 = '#475467';
/** Axis and tick labels are text, so this is the AA-safe grey, not #98A2B3. */
export const TEXT_3 = '#667085';
export const UP = '#12B76A';
export const DOWN = '#F04438';
/** Outlines on the fills above, so a bar's boundary clears 3:1 on the surface. */
export const UP_EDGE = '#027A48';
export const DOWN_EDGE = '#B42318';
export const WARN = '#F79009';

/**
 * Deals no channel can claim are not given a categorical hue.
 *
 * Handing them a slot beside the channels would undo in the chart exactly what
 * the table's separate row group establishes: they are a population, not a
 * channel, and they have no spend behind them.
 */
export const UNATTRIBUTED = '#98A2B3';

/**
 * A channel keeps its colour by identity, never by rank, so filtering one out
 * never repaints the others.
 */
export function channelColor(platform: string, order: readonly string[]): string {
  const i = order.indexOf(platform);
  return SERIES[(i < 0 ? 0 : i) % SERIES.length]!;
}
