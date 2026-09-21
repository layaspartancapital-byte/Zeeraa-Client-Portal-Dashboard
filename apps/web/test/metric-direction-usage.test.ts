import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Direction is a property of the metric, so no screen may state one.
 *
 * `Delta` colours a change by `improvement_direction`, and the whole point is
 * that the value comes from the metric's definition rather than from whoever
 * wrote the card. Nothing in TypeScript stops a card passing `direction="up"`
 * and painting a rising cost green, so this reads the sources instead.
 *
 * A source-level test is unusual here and earns its place: the thing being
 * prevented is a plausible one-line edit that produces a plausible-looking
 * screen, and no type or runtime check can see it.
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

describe('how screens obtain an improvement direction', () => {
  it('finds the Delta component and its call sites, so the scan is not vacuous', () => {
    expect(files.some((f) => f.path.endsWith('ui/Delta.tsx'))).toBe(true);
    const callSites = files.filter(
      (f) => !f.path.endsWith('ui/Delta.tsx') && /<Delta\b/.test(f.text),
    );
    expect(callSites.length).toBeGreaterThan(0);
  });

  it('never states a direction as a literal', () => {
    const offenders: string[] = [];
    for (const { path, text } of files) {
      // `direction="up"`, `direction={'down'}`, `direction={"up"}`.
      const literal = /\bdirection=\{?\s*['"](up|down)['"]/g;
      for (const match of text.matchAll(literal)) {
        offenders.push(`${path.replace(SRC, 'src')}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('takes every direction from the metric rather than from the card', () => {
    const offenders: string[] = [];
    for (const { path, text } of files) {
      if (path.endsWith('ui/Delta.tsx')) continue;
      for (const match of text.matchAll(/\bdirection=\{([^}]*)\}/g)) {
        const expression = match[1]!.trim();
        if (/^metrics\.direction\(/.test(expression)) continue;

        // A bare identifier is allowed only where the file says where it came
        // from: a prop typed `ImprovementDirection | null` and threaded down
        // (`HeroCard` does this), or a local bound to `metrics.direction(...)`
        // because the page needs it more than once. Anything else — a literal,
        // a ternary, a call to something else — is the card deciding.
        const identifier = /^[a-zA-Z_$][\w$]*$/.test(expression) ? expression : null;
        if (identifier) {
          const typedAsProp = /direction:\s*ImprovementDirection\s*\|\s*null/.test(text);
          const boundToMetric = new RegExp(
            `\\b(const|let)\\s+${identifier}\\b[^=]*=\\s*metrics\\.direction\\(`,
          ).test(text);
          if (typedAsProp || boundToMetric) continue;
          offenders.push(
            `${path.replace(SRC, 'src')}: direction={${identifier}} — neither a typed prop nor bound to metrics.direction()`,
          );
          continue;
        }
        offenders.push(`${path.replace(SRC, 'src')}: direction={${expression}}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
