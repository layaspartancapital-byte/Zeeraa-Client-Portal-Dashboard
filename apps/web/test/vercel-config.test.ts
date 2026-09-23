import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Where Vercel actually reads its configuration.
 *
 * The Vercel project's Root Directory is `apps/web`, so Vercel reads
 * `apps/web/vercel.json` and nothing above it. Until 23 September 2026 the file
 * sat at the repository root: no cron ever registered (the Cron Jobs page
 * showed only its "Get Started" guide), and the preflight build command never
 * ran on a deploy either — both had been "verified" locally, where the file's
 * location does not matter.
 */
const WEB = join(import.meta.dirname, '..');
const ROOT = join(WEB, '..', '..');

describe('vercel.json', () => {
  it('lives in the Root Directory, and nowhere else', () => {
    expect(existsSync(join(WEB, 'vercel.json'))).toBe(true);
    // A second copy at the root is the one somebody would edit, and Vercel ignores it.
    expect(existsSync(join(ROOT, 'vercel.json'))).toBe(false);
  });

  const config = JSON.parse(readFileSync(join(WEB, 'vercel.json'), 'utf8')) as {
    buildCommand?: string;
    crons?: { path: string; schedule: string }[];
  };

  it('registers the hourly sync, the ten-minute Salesforce sync, the nightly re-pull and the reconciliation', () => {
    expect(config.crons?.map((c) => c.path).sort()).toEqual([
      '/api/cron/nightly',
      '/api/cron/reconcile',
      '/api/cron/salesforce',
      '/api/cron/sync',
    ]);
    expect(config.crons?.find((c) => c.path === '/api/cron/salesforce')?.schedule).toBe('*/10 * * * *');
    expect(config.crons?.find((c) => c.path === '/api/cron/sync')?.schedule).toBe('0 * * * *');
    for (const cron of config.crons ?? []) {
      // Each path is a route that exists.
      const route = join(WEB, 'src', 'app', ...cron.path.split('/').filter(Boolean), 'route.ts');
      expect(existsSync(route), cron.path).toBe(true);
      // Strict schema: an unknown key fails the deploy, so none are added.
      expect(Object.keys(cron).sort()).toEqual(['path', 'schedule']);
    }
  });

  it('builds only after preflight passes', () => {
    expect(config.buildCommand).toMatch(/^pnpm --filter @zeeraa\/db preflight && /);
  });
});
