import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every dashboard page refreshes itself on the Salesforce cadence, in place.
 *
 * Read from source because the behaviour is timers and visibility events: what
 * matters is that the refresh is `router.refresh()` (keeps the URL, the picked
 * range and the scroll position), never a reload; that it stands down while
 * the tab is hidden; and that every dashboard page carries it.
 */
const SRC = join(import.meta.dirname, '..', 'src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

describe('AutoRefresh', () => {
  const code = read('components/shell/AutoRefresh.tsx');

  it('refreshes in place every ten minutes, matching the Salesforce cron', () => {
    expect(code).toMatch(/router\.refresh\(\)/);
    // Comments stripped: the component's own comment explains why it is not a reload.
    const executable = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(executable).not.toMatch(/location\.reload|window\.location\s*=/);
    expect(code).toMatch(/REFRESH_INTERVAL_SECONDS = 600/);
    const cron = JSON.parse(readFileSync(join(SRC, '..', 'vercel.json'), 'utf8')) as {
      crons: { path: string; schedule: string }[];
    };
    expect(cron.crons.find((c) => c.path === '/api/cron/salesforce')?.schedule).toBe('*/10 * * * *');
  });

  it('pauses while the tab is hidden and measures from the last refresh', () => {
    expect(code).toMatch(/visibilitychange/);
    expect(code).toMatch(/visibilityState !== 'visible'/);
    expect(code).toMatch(/last\.current = at/);
  });

  it('is on every dashboard page', () => {
    for (const page of [
      'app/[tenant]/page.tsx',
      'app/[tenant]/performance/page.tsx',
      'app/[tenant]/funnel/page.tsx',
      'app/[tenant]/platforms/[platform]/page.tsx',
      'components/platform/OrganicPlatformView.tsx',
      'app/[tenant]/connections/page.tsx',
    ]) {
      expect(read(page), page).toMatch(/<AutoRefresh \/>/);
    }
  });

  it('is not on the forms', () => {
    expect(read('app/[tenant]/people/page.tsx')).not.toMatch(/AutoRefresh/);
  });
});
