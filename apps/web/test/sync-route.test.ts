import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * "Sync now" is open to clients. The route must take the tenant from the
 * viewer's own membership — never from the URL alone — admit every role, and
 * turn the throttle into a 429 carrying the sentence the button shows. The
 * database half (lock, throttle, row level security) is
 * `packages/jobs/test/manual-sync.test.ts`.
 */
const runManualSync = vi.fn();
const requireRole = vi.fn();
vi.mock('@zeeraa/jobs', () => ({ runManualSync: (o: unknown) => runManualSync(o) }));
vi.mock('@/lib/tenant', () => ({ requireRole: (s: string, p: unknown) => requireRole(s, p) }));

const { POST } = await import('../src/app/api/sync/[tenant]/route');

const call = (slug: string, platform?: string) =>
  POST(new NextRequest(`http://localhost/api/sync/${slug}${platform ? `?platform=${platform}` : ''}`, { method: 'POST' }), {
    params: Promise.resolve({ tenant: slug }),
  });

/** Stands in for `requireRole`: the viewer is a member of `spartan` only. */
function memberOf(role: string) {
  requireRole.mockImplementation(async (slug: string, permitted: (r: string) => boolean) => {
    if (slug !== 'spartan' || !permitted(role)) throw new Error('NEXT_REDIRECT');
    return { tenant: { id: 'tenant-spartan', slug: 'spartan', role } };
  });
}

beforeEach(() => {
  runManualSync.mockReset();
  requireRole.mockReset();
});

describe('POST /api/sync/[tenant]', () => {
  for (const role of ['client_viewer', 'client_admin', 'zeeraa_member', 'zeeraa_admin']) {
    it(`lets a ${role} sync their own tenant, by the session's tenant id, ${role === 'zeeraa_admin' ? 'unthrottled' : 'throttled'}`, async () => {
      memberOf(role);
      runManualSync.mockResolvedValue({ status: 'ran', result: { ok: true, outcomes: [{ platform: 'meta' }], durationMs: 1 } });
      const res = await call('spartan', 'meta');
      expect(res.status).toBe(200);
      expect(runManualSync).toHaveBeenCalledWith({
        tenantId: 'tenant-spartan',
        platforms: ['meta'],
        throttle: role !== 'zeeraa_admin',
      });
    });
  }

  it("never syncs a tenant the viewer does not belong to", async () => {
    memberOf('client_admin');
    await expect(call('another-lender')).rejects.toThrow('NEXT_REDIRECT');
    expect(runManualSync).not.toHaveBeenCalled();
  });

  it('answers a second press inside five minutes with 429 and the wait', async () => {
    memberOf('client_viewer');
    const nextAt = new Date(Date.now() + 3 * 60_000);
    runManualSync.mockResolvedValue({ status: 'throttled', lastAt: new Date(), nextAt, message: 'Synced 2 min ago, next available in 3 min' });
    const res = await call('spartan');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(170);
    expect(await res.json()).toMatchObject({ ok: false, throttled: true, error: 'Synced 2 min ago, next available in 3 min' });
  });

  it('answers a press while a sync is running with 429', async () => {
    memberOf('client_viewer');
    runManualSync.mockResolvedValue({ status: 'running', message: 'A sync is already running for this client.' });
    const res = await call('spartan');
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ throttled: true });
  });

  it('refuses an unknown platform before syncing anything', async () => {
    memberOf('client_viewer');
    const res = await call('spartan', 'tiktok');
    expect(res.status).toBe(400);
    expect(runManualSync).not.toHaveBeenCalled();
  });
});
