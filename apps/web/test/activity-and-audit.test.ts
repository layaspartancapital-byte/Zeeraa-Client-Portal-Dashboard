import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenant', () => ({ queryTenant: vi.fn() }));

const { activityPath, pageLabel } = await import('../src/lib/activity');
const { formatWhen } = await import('../src/lib/when');

const src = (path: string) => readFileSync(join(__dirname, '../src', path), 'utf8');

describe('activityPath', () => {
  it('keeps a pathname inside the tenant and drops the query', () => {
    expect(activityPath('spartan', '/spartan')).toBe('/spartan');
    expect(activityPath('spartan', '/spartan/funnel?from=2026-09-01')).toBe('/spartan/funnel');
  });

  it('refuses anything outside it', () => {
    expect(activityPath('spartan', '/spartanx/funnel')).toBeNull();
    expect(activityPath('spartan', '/other')).toBeNull();
    expect(activityPath('spartan', 42)).toBeNull();
    expect(activityPath('spartan', `/spartan/${'x'.repeat(400)}`)).toBeNull();
  });
});

describe('pageLabel', () => {
  it('names a page as the rail does', () => {
    expect(pageLabel('spartan', '/spartan')).toBe('Executive');
    expect(pageLabel('spartan', '/spartan/performance')).toBe('Monthly performance');
    expect(pageLabel('spartan', '/spartan/admin')).toBe('Reconciliation');
    expect(pageLabel('spartan', '/spartan/platforms/google_ads')).toBe('Google Ads');
  });
});

describe('formatWhen', () => {
  const tz = 'America/New_York';
  const now = new Date('2026-09-25T18:00:00Z'); // 2:00 PM EDT

  it('reads minutes, then today, then a date', () => {
    expect(formatWhen(new Date('2026-09-25T17:59:40Z'), now, tz)).toBe('Just now');
    expect(formatWhen(new Date('2026-09-25T17:48:00Z'), now, tz)).toBe('12 min ago');
    expect(formatWhen(new Date('2026-09-25T13:05:00Z'), now, tz)).toBe('Today, 9:05 AM');
    expect(formatWhen(new Date('2026-09-22T20:30:00Z'), now, tz)).toBe('Sep 22, 4:30 PM');
    expect(formatWhen(new Date('2025-12-31T20:30:00Z'), now, tz)).toBe('Dec 31, 2025, 3:30 PM');
  });

  it('decides "today" in the tenant’s day, not UTC’s', () => {
    // 01:30Z on the 26th is 9:30 PM on the 25th in New York.
    expect(formatWhen(new Date('2026-09-26T01:30:00Z'), new Date('2026-09-26T03:00:00Z'), tz)).toBe(
      'Today, 9:30 PM',
    );
  });
});

describe('the audit log is written where the action happens', () => {
  const lib = src('lib/users.ts');

  it('records every account action inside its own transaction', () => {
    for (const [fn, action] of [
      ['createUser', 'create_account'],
      ['grantMembership', 'grant_access'],
      ['resetPassword', 'reset_password'],
      ['revokeMembership', 'remove_access'],
    ]) {
      const body = lib.slice(lib.indexOf(`export async function ${fn}(`));
      const next = body.indexOf('\nexport ', 1);
      expect(body.slice(0, next === -1 ? undefined : next)).toMatch(
        new RegExp(`recordAccountAction\\(tx, session, \\{\\s+action: '${action}'`),
      );
    }
  });

  it('records a sign-in before the session exists', () => {
    const signin = src('app/signin/page.tsx');
    const recorded = signin.indexOf('await recordSignIn(');
    expect(recorded).toBeGreaterThan(-1);
    expect(recorded).toBeLessThan(signin.indexOf('await createSession('));
  });

  it('never counts the auto-refresh as a visit', () => {
    // The beacon's effect depends on the pathname alone; `record` is a fresh
    // function on every server render.
    expect(src('components/shell/ActivityBeacon.tsx')).toContain('}, [pathname]);');
  });
});

describe('formatInstant', () => {
  it('names the zone', async () => {
    const { formatInstant } = await import('../src/lib/when');
    expect(formatInstant(new Date('2026-09-25T18:00:00Z'), 'America/New_York')).toBe(
      'Sep 25, 2026, 2:00 PM EDT',
    );
  });
});
