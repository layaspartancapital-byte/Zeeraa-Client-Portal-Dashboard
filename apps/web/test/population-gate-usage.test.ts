import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A screen may not decide how small a population is too small.
 *
 * The companion to `metric-direction-usage.test.ts`, guarding the same class of
 * mistake from the other side. Which way is better is a property of the metric;
 * so is whether a figure needs a population, and how large that population must
 * be is the tenant's `min_rate_denominator`. A card that called
 * `assessPopulation` itself would be free to pass `3` — or to skip the gate
 * altogether — and the result would be a plausible-looking screen with a cost
 * per deal over two deals on it.
 *
 * So every gate on a screen comes from `metrics.population(key, denominator)`,
 * which resolves the formula from the metric row and the floor from
 * configuration. A source-level test because no type can see the difference
 * between a floor read from config and a literal `10`.
 */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

const SRC = join(import.meta.dirname, '..', 'src');
const files = sources(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

describe('how screens obtain a population gate', () => {
  it('finds the gate and its call sites, so the scan is not vacuous', () => {
    const provider = files.find((f) => f.path.endsWith('lib/dashboard.ts'));
    expect(provider?.text).toMatch(/population:\s*\(key, population\)/);

    const callSites = files.filter((f) => /metrics\.population\(/.test(f.text));
    expect(callSites.length).toBeGreaterThan(0);
  });

  it('never calls assessPopulation directly from a screen or a component', () => {
    const offenders = files
      .filter((f) => !f.path.endsWith('lib/dashboard.ts'))
      .filter((f) => /\bassessPopulation\s*\(/.test(f.text))
      .map((f) => f.path.replace(SRC, 'src'));
    expect(offenders).toEqual([]);
  });

  it('never states a population floor as a literal', () => {
    // `metrics.population(key, denominator)` is the only shape. A third
    // argument is a caller choosing the floor; a number where the denominator
    // goes is a caller inventing a population.
    const offenders: string[] = [];
    for (const { path, text } of files) {
      for (const match of text.matchAll(/metrics\.(?:population|comparable)\(([\s\S]*?)\)(?=[,;\s)])/g)) {
        const args = splitArgs(match[1]!);
        if (args.length !== 2) {
          offenders.push(
            `${path.replace(SRC, 'src')}: ${args.length} arguments — expected (key, denominator)`,
          );
          continue;
        }
        if (/^\d+$/.test(args[1]!)) {
          offenders.push(`${path.replace(SRC, 'src')}: denominator is the literal ${args[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gates every cost the executive briefing renders', () => {
    // The briefing's efficiency table divides one channel's spend by that
    // channel's records at four stages, and its funded-deal column routinely
    // divides by one or two. A cell that stopped being gated would render that
    // as a cost per funded deal, which is the figure a client repeats.
    const page = files.find((f) => f.path.endsWith(join('[tenant]', 'page.tsx')));
    expect(page).toBeDefined();
    expect(page!.text).toContain("metrics.population('speed_to_lead'");
    expect(page!.text).toMatch(/gate:\s*metrics\.population\(/);

    // And the table must render the verdict rather than accept it and ignore
    // it: a gate computed and never read is worse than no gate, because the
    // test above passes.
    const table = files.find((f) => f.path.endsWith('EfficiencyTable.tsx'));
    expect(table).toBeDefined();
    expect(table!.text).toMatch(/gate\.sufficient/);
  });
});

/**
 * Split an argument list on top-level commas only.
 *
 * A naive `split(',')` counts the comma inside `f(a, b)` or inside an object
 * literal, so a two-argument call written across three lines reads as three
 * arguments and the test fails on formatting rather than on substance. It did,
 * which is why this exists.
 */
function splitArgs(source: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of source) {
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) args.push(current.trim());
  return args.filter((a) => a.length > 0);
}
