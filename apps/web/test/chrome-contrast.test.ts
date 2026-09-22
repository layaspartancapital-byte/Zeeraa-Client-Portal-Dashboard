import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The rebrand's contrast promises, read out of the stylesheet.
 *
 * Spec v2 §1 keeps WCAG AA, and this file exists because the rebrand added the
 * one palette where that is easy to lose: gold on near-black looks fine at any
 * value, so the failing combinations are the ones nobody squints at. The
 * stylesheet already carries one darkened token — `--text-3` — for exactly this
 * reason, and it was found by arithmetic rather than by eye.
 *
 * Reads `globals.css` rather than restating the values, so a token edited in
 * the stylesheet is what gets checked.
 */
const css = readFileSync(join(__dirname, '../src/app/globals.css'), 'utf8');

function token(name: string): string {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(css);
  if (!match) throw new Error(`--color-${name} is not defined in globals.css`);
  return match[1]!;
}

function luminance(hex: string): number {
  const c = hex.replace('#', '');
  const full = c.length === 3 ? [...c].map((ch) => ch + ch).join('') : c;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const AA_TEXT = 4.5;
/** WCAG 1.4.11: a graphical object that carries meaning. */
const AA_OBJECT = 3;

describe('type on the dark chrome', () => {
  const chrome = token('chrome');
  const raised = token('chrome-raised');

  it.each(['on-chrome', 'on-chrome-2', 'on-chrome-3'])('%s clears AA on both grounds', (name) => {
    expect(ratio(token(name), chrome)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(ratio(token(name), raised)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('keeps the chrome near-black rather than black', () => {
    // A judgement, but a checkable one: pure #000 against a white card is a
    // harder edge than any screen needs.
    expect(chrome).not.toBe('#000000');
    expect(luminance(chrome)).toBeGreaterThan(0);
    expect(luminance(chrome)).toBeLessThan(0.02);
  });
});

describe('gold', () => {
  const gold = token('gold');

  it('clears AA as the active nav label, on the row and on its wash', () => {
    // The row has a background, so both grounds have to hold. This is the test
    // the logo's own #A77F41 fails at 4.42:1, which is why the token is lifted.
    expect(ratio(gold, token('chrome'))).toBeGreaterThanOrEqual(AA_TEXT);
    expect(ratio(gold, token('chrome-raised'))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('clears the graphical-object bar as the 3px indicator', () => {
    expect(ratio(gold, token('chrome'))).toBeGreaterThanOrEqual(AA_OBJECT);
  });

  it('cannot carry type on the light content, which is why it never does', () => {
    // Asserted as a failure on purpose. If someone lightens the canvas or picks
    // a darker gold until this passes, the rule stops being load-bearing and
    // the next person will reasonably use gold for a figure.
    expect(ratio(gold, token('canvas'))).toBeLessThan(AA_TEXT);
    expect(ratio(gold, token('surface'))).toBeLessThan(AA_TEXT);
  });
});

describe('gold appears in the chrome and nowhere else', () => {
  const sources = import.meta.glob('../src/**/*.{ts,tsx}', {
    eager: true,
    query: '?raw',
    import: 'default',
  }) as Record<string, string>;

  it('is used only by the rail and the title band', () => {
    // The palette rule as a grep, because it is the one that erodes quietly:
    // gold on a KPI figure or a chart line is a one-line change that nobody
    // reviews as a palette decision.
    const offenders = Object.entries(sources)
      .filter(([path]) => !path.includes('/shell/'))
      .filter(([, source]) => /\b(?:bg|text|border|fill|stroke|ring)-gold\b/.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('never touches a chart, whatever the file', () => {
    const inCharts = Object.entries(sources)
      .filter(([path]) => path.includes('/charts/'))
      .filter(([, source]) => /gold/.test(source))
      .map(([path]) => path);
    expect(inCharts).toEqual([]);
  });
});

describe('the tenant mark stays legible on chrome', () => {
  it('rings it, because a dark accent is under the graphical-object bar', () => {
    // Spartan's #2F5D8C is 2.64:1 against the rail. The ring is what fixes it,
    // so the ring has to clear the bar the fill does not.
    expect(ratio('#2F5D8C', token('chrome'))).toBeLessThan(AA_OBJECT);
    expect(ratio(token('on-chrome-3'), token('chrome'))).toBeGreaterThanOrEqual(AA_OBJECT);
  });
});
