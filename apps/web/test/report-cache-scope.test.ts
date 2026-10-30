import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A report that reads calls is cached with `'calls'` (30 October 2026).
 *
 * The cache keys most reports on everything but call deliveries, so a call
 * ending does not recompute the funnel. A report that reads `calls` or
 * `webhook_deliveries` and is cached without the scope would sit on a stale
 * call count until the next sync. This reads the report modules, finds every
 * function that touches either table, and fails if `cached-reports.ts` caches
 * one — or a function that calls one — without `'calls'`.
 */
const lib = (name: string) => readFileSync(join(__dirname, '../src/lib', name), 'utf8');
const MODULES: Record<string, string> = {
  reporting: 'reporting.ts',
  dashboard: 'dashboard.ts',
  coverage: 'coverage.ts',
  breakdown: 'breakdown.ts',
  quality: 'quality-measures.ts',
  platforms: 'platforms.ts',
  platform: 'platform.ts',
  organic: 'organic.ts',
  seo: 'seo.ts',
  tenant: 'tenant.ts',
};
const READS_CALLS = /schema\.calls\b|callsIn\(|webhookDeliveries|webhook_deliveries|\bfrom calls\b/;

/** Top-level functions in a module, with their bodies. */
function functions(code: string): Map<string, string> {
  const out = new Map<string, string>();
  const starts = [...code.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)];
  starts.forEach((m, i) => out.set(m[1]!, code.slice(m.index, starts[i + 1]?.index ?? code.length)));
  return out;
}

const bodies = new Map<string, string>();
for (const [alias, file] of Object.entries(MODULES)) {
  for (const [name, body] of functions(lib(file))) bodies.set(`${alias}.${name}`, body);
}
const direct = new Set([...bodies].filter(([, body]) => READS_CALLS.test(body)).map(([name]) => name));
/** Reads calls itself, or calls a function that does. */
const readsCalls = (qualified: string) => {
  const body = bodies.get(qualified) ?? '';
  return direct.has(qualified) || [...direct].some((d) => new RegExp(`\\b${d.split('.')[1]}\\(`).test(body));
};

describe('cached-reports scopes', () => {
  it('finds the reports that read calls', () => {
    expect(direct).toContain('reporting.callReport');
    expect(direct).toContain('coverage.sourcesThrough');
  });

  it("caches every report that reads calls with 'calls'", () => {
    const code = lib('cached-reports.ts');
    const wrong: string[] = [];
    for (const m of code.matchAll(/cached\('(\w+)', (\w+)\.(\w+)(, '(\w+)')?\)/g)) {
      const qualified = `${m[2]}.${m[3]}`;
      if (readsCalls(qualified) && m[5] !== 'calls') wrong.push(qualified);
    }
    expect(wrong).toEqual([]);
  });

  it('hands windowBuckets the cached sourcesThrough, and keys on it', () => {
    const code = lib('cached-reports.ts');
    expect(code).toMatch(/\[range, granularity, model, through\]/);
  });
});
