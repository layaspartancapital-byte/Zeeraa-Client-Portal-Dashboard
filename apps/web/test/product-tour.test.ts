/**
 * The product tour lights elements by `data-tour` name, and a renamed or
 * removed element would not fail anything: the step would wait, be skipped,
 * and the tour would quietly lose it. This reads the sources and fails if a
 * step names an element nothing renders.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STEPS } from '../src/components/shell/tour-steps';

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx$/.test(path)) out.push(path);
  }
  return out;
}

const SRC = join(import.meta.dirname, '..', 'src');
const text = sources(SRC)
  .filter((path) => !path.endsWith('ProductTour.tsx'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');

describe('the product tour', () => {
  it('has the eight approved steps, in order', () => {
    expect(STEPS.map((s) => `${s.path || '/'} ${s.target}`)).toEqual([
      '/ date-range',
      '/ scorecard',
      '/ cost-chart',
      '/ freshness',
      '/ how-measured',
      '/funnel funnel',
      '/performance performance-table',
      '/performance export-csv',
    ]);
  });

  it('lights only elements something renders', () => {
    const missing = STEPS.filter(
      (s) => !text.includes(`data-tour="${s.target}"`) && !text.includes(`dataTour="${s.target}"`),
    ).map((s) => s.target);
    expect(missing).toEqual([]);
  });

  it('keeps every caption to one plain sentence', () => {
    for (const step of STEPS) {
      expect(step.caption.match(/[.!?](\s|$)/g)?.length, step.target).toBe(1);
    }
  });
});
