import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every entry point behind People refuses anybody `canManageUsers` refuses.
 *
 * A server action is a POST endpoint: hiding the page does not stop somebody
 * calling it. So the page and each action must check for themselves, and the
 * library functions they call must check again. This reads the sources and
 * fails if one stops doing so; the database half is in
 * `packages/db/test/account-admin.test.ts`.
 */
const src = (path: string) => readFileSync(join(__dirname, '../src', path), 'utf8');

describe('People', () => {
  const page = src('app/[tenant]/people/page.tsx');

  it('guards the page and every server action with canManageUsers', () => {
    const actions = page.split("'use server';").length - 1;
    expect(actions).toBeGreaterThan(0);
    const guards = page.match(/await requireRole\(slug, canManageUsers\)/g) ?? [];
    // The page itself, plus one per action.
    expect(guards.length).toBe(actions + 1);
  });

  it('re-checks inside every library function that changes an account', () => {
    const lib = src('lib/users.ts');
    for (const fn of ['createUser', 'grantMembership', 'resetPassword', 'revokeMembership']) {
      const body = lib.slice(lib.indexOf(`export async function ${fn}(`));
      const next = body.indexOf('\nexport ', 1);
      expect(body.slice(0, next === -1 ? undefined : next)).toContain('assertMayManage(session)');
    }
  });

  it('hides People from the rail with the same predicate', () => {
    expect(src('components/shell/Sidebar.tsx')).toContain(
      "{ segment: 'people', label: 'People', icon: Users, permitted: canManageUsers }",
    );
  });
});
