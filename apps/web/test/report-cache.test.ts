import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The between-syncs report cache (24 September 2026): a result is reused only
 * while the tenant's data version holds, so a finished sync — which moves the
 * version — makes the next request recompute.
 */
let version = 'v1';
vi.mock('server-only', () => ({}));
vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(fn: T) => fn }));
vi.mock('@/lib/tenant', () => ({
  queryTenant: async (_s: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({ execute: async () => [{ v: version }] }),
}));

const session = (tenantId = 't1', role = 'zeeraa_admin') =>
  ({ tenant: { id: tenantId, role, timezone: 'America/New_York' } }) as never;

describe('cachedReport', () => {
  beforeEach(() => {
    version = `v-${Math.random()}`;
  });

  it('reuses a result while the data version holds, and recomputes when a sync moves it', async () => {
    const { cachedReport } = await import('../src/lib/report-cache');
    const fn = vi.fn(async () => ({ deals: 3 }));
    await cachedReport(session(), 'r', [1], fn);
    await cachedReport(session(), 'r', [1], fn);
    expect(fn).toHaveBeenCalledTimes(1);
    version = 'after-sync';
    await cachedReport(session(), 'r', [1], fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('keys by tenant, role and arguments', async () => {
    const { cachedReport } = await import('../src/lib/report-cache');
    const fn = vi.fn(async () => 1);
    await cachedReport(session('t1'), 'r', [1], fn);
    await cachedReport(session('t2'), 'r', [1], fn);
    await cachedReport(session('t1', 'client_viewer'), 'r', [1], fn);
    await cachedReport(session('t1'), 'r', [2], fn);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('hands every caller its own copy, Dates and Maps intact', async () => {
    const { cachedReport } = await import('../src/lib/report-cache');
    const fn = async () => ({ at: new Date('2026-09-24T00:00:00Z'), byPlatform: new Map([['google_ads', 1]]), rows: [3, 1, 2] });
    const a = await cachedReport(session(), 'clone', [], fn);
    a.rows.sort();
    a.byPlatform.set('meta', 2);
    const b = await cachedReport(session(), 'clone', [], fn);
    expect(b.rows).toEqual([3, 1, 2]);
    expect(b.byPlatform.has('meta')).toBe(false);
    expect(b.at).toBeInstanceOf(Date);
  });

  it('does not keep a failure', async () => {
    const { cachedReport } = await import('../src/lib/report-cache');
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls === 1) throw new Error('database down');
      return 'ok';
    };
    await expect(cachedReport(session(), 'fail', [], fn)).rejects.toThrow('database down');
    await expect(cachedReport(session(), 'fail', [], fn)).resolves.toBe('ok');
  });
});
