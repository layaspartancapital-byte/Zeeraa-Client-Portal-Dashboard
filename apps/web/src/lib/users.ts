import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { schema, withUserOnly } from '@zeeraa/db';
import {
  assignableRoles,
  canManageUsers,
  checkPassword,
  type Role,
} from '@zeeraa/core';
import { hashPassword, newInitialPassword } from '@/lib/password';
import { destroyAllSessions } from '@/lib/session';
import { queryTenant, type TenantSession } from '@/lib/tenant';

/**
 * Account administration: create a person, reset their password, take their
 * access away.
 *
 * Every write here runs inside `queryTenant`, so the policies added in
 * migration 0017 are the boundary and the role checks below are the second of
 * two. The checks exist to produce a readable message instead of a constraint
 * violation — deleting them would change the error, not the outcome.
 *
 * The division the brief asks for is visible in `createUser`: the `users` row
 * and the `memberships` row are two statements with two different policies
 * behind them. An account can exist with no membership, and it reaches
 * `/no-access` and nothing else.
 */

export class UserAdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'UserAdminError';
  }
}

export type RosterEntry = {
  userId: string;
  email: string;
  name: string | null;
  title: string | null;
  role: Role;
  /** True where they have not yet replaced the password an admin set. */
  mustChangePassword: boolean;
  /** Null where nobody has ever set a password — the account cannot sign in. */
  passwordUpdatedAt: Date | null;
  hasPassword: boolean;
};

/** Everybody with a membership in this tenant. */
export function tenantRoster(session: TenantSession): Promise<RosterEntry[]> {
  return queryTenant(session, (tx) =>
    tx
      .select({
        userId: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        title: schema.users.title,
        role: schema.memberships.role,
        mustChangePassword: schema.users.mustChangePassword,
        passwordUpdatedAt: schema.users.passwordUpdatedAt,
        hasPassword: schema.users.passwordHash,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.tenantId, session.tenant.id))
      .orderBy(asc(schema.users.email)),
  ).then((rows) =>
    rows.map(({ hasPassword, ...rest }) => ({ ...rest, hasPassword: hasPassword !== null })),
  );
}

function assertMayManage(session: TenantSession): void {
  if (!canManageUsers(session.tenant.role)) {
    throw new UserAdminError('You cannot manage people in this engagement.', 403);
  }
}

function assertMayGrant(session: TenantSession, role: Role): void {
  if (!assignableRoles(session.tenant.role).includes(role)) {
    throw new UserAdminError(`You cannot grant the ${role} role.`, 403);
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A Postgres unique-violation, through however many wrappers drizzle and
 * postgres.js have put around it. The code is on the original error, which
 * travels as `cause`.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth += 1) {
    if (typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23505') {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export type CreatedUser = { userId: string; email: string; initialPassword: string };

/**
 * Creates an account and grants it access to the tenant being administered.
 *
 * Returns the initial password **once**, for the admin to pass on out of band.
 * It is never stored in readable form and there is no screen that can show it
 * again — a reset issues a new one, which is the honest alternative to a
 * recovery flow this product has no email to run.
 *
 * The id is generated here rather than by the database, because
 * `INSERT … RETURNING` applies the SELECT policy to the returned row and the
 * new user has no membership yet, so there would be nothing to return. Reading
 * back a row that is deliberately invisible is the wrong fix; knowing the id
 * before the insert is the right one.
 */
export async function createUser(
  session: TenantSession,
  input: { email: string; name: string; title?: string; role: Role },
): Promise<CreatedUser> {
  assertMayManage(session);
  assertMayGrant(session, input.role);

  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new UserAdminError('That is not a valid email address.', 400);
  const name = input.name.trim();
  if (name.length === 0) throw new UserAdminError('A name is required.', 400);

  const initialPassword = newInitialPassword();
  const passwordHash = await hashPassword(initialPassword);
  const userId = randomUUID();

  await queryTenant(session, async (tx) => {
    // One transaction: an account created without its membership would be
    // invisible to the admin who just created it and impossible to finish.
    try {
      await tx.insert(schema.users).values({
        id: userId,
        email,
        name,
        title: input.title?.trim() || null,
        passwordHash,
        // The admin knows this password. It is a delivery mechanism, not a
        // credential, so it is spent the first time it is used.
        mustChangePassword: true,
        passwordUpdatedAt: new Date(),
      });
    } catch (error) {
      // 23505 on `users_email_key` is the only expected failure: the address is
      // taken. Everything else is a real error and must not be reported as a
      // duplicate.
      //
      // Caught rather than avoided with `onConflictDoNothing`, because a
      // swallowed conflict is indistinguishable from a successful insert here.
      // The SELECT policy admits only people who share the current tenant, and
      // this row has no membership yet — so reading back to see whether the
      // insert landed returns nothing either way, and the happy path reports a
      // collision that did not happen.
      if (isUniqueViolation(error)) {
        // Deliberately does not say which engagement holds it. That the address
        // belongs to another client is not this admin's to learn.
        throw new UserAdminError(
          'An account already exists for that address. Ask a Zeeraa admin to grant ' +
            'it access to this engagement instead of creating a second one.',
          409,
        );
      }
      throw error;
    }

    await tx.insert(schema.memberships).values({
      userId,
      tenantId: session.tenant.id,
      role: input.role,
    });
  });

  return { userId, email, initialPassword };
}

/**
 * Grants an existing account access to this tenant.
 *
 * Separate from `createUser` because the brief asks for it to be: a Zeeraa
 * admin joining a second engagement already has an account, and creating a
 * duplicate would give them two.
 */
export async function grantMembership(
  session: TenantSession,
  input: { email: string; role: Role },
): Promise<void> {
  assertMayManage(session);
  assertMayGrant(session, input.role);
  const email = input.email.trim().toLowerCase();

  await queryTenant(session, async (tx) => {
    const [user] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));

    // The `users` SELECT policy only admits people who already share this
    // tenant, so an account that exists elsewhere reads as absent here. That is
    // the boundary working: this admin has no business learning that an address
    // holds an account in somebody else's engagement.
    if (!user) {
      throw new UserAdminError(
        'No account here for that address. Create one, or ask a Zeeraa admin if ' +
          'it belongs to another engagement.',
        404,
      );
    }

    await tx
      .insert(schema.memberships)
      .values({ userId: user.id, tenantId: session.tenant.id, role: input.role })
      .onConflictDoNothing();
  });
}

/**
 * Issues a new password for somebody and ends every session they hold.
 *
 * The sessions have to go. A reset whose usual cause is "that password reached
 * the wrong person" is not a reset if whoever used it stays signed in.
 */
export async function resetPassword(
  session: TenantSession,
  userId: string,
): Promise<{ email: string; initialPassword: string }> {
  assertMayManage(session);

  const initialPassword = newInitialPassword();
  const passwordHash = await hashPassword(initialPassword);

  const email = await queryTenant(session, async (tx) => {
    const [row] = await tx
      .update(schema.users)
      .set({ passwordHash, mustChangePassword: true, passwordUpdatedAt: new Date() })
      .where(eq(schema.users.id, userId))
      .returning({ email: schema.users.email });

    // `users_admin_manage` admits only a user who shares the current tenant, so
    // a target outside it updates nothing rather than erroring.
    if (!row) throw new UserAdminError('No such person in this engagement.', 404);
    return row.email;
  });

  await destroyAllSessions(userId);
  return { email, initialPassword };
}

/**
 * Removes somebody's access to this tenant.
 *
 * The account survives — it may hold other engagements, and deleting a user row
 * would take their history with it. What goes is the membership, which is where
 * access lives, and their sessions, so it takes effect on the next request
 * rather than in a fortnight.
 */
export async function revokeMembership(
  session: TenantSession,
  userId: string,
): Promise<void> {
  assertMayManage(session);
  if (userId === session.viewer.userId) {
    throw new UserAdminError('You cannot remove your own access.', 400);
  }

  const removed = await queryTenant(session, (tx) =>
    tx
      .delete(schema.memberships)
      .where(
        and(
          eq(schema.memberships.userId, userId),
          eq(schema.memberships.tenantId, session.tenant.id),
        ),
      )
      .returning({ userId: schema.memberships.userId }),
  );
  if (removed.length === 0) throw new UserAdminError('No such person in this engagement.', 404);

  // Only if this was their last engagement. Somebody who still holds another
  // should not be signed out of it because this one ended.
  const remaining = await withUserOnly(userId, (tx) =>
    tx
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, userId)),
  );
  if (remaining.length === 0) await destroyAllSessions(userId);
}

/**
 * The signed-in person replacing their own password.
 *
 * Runs on the application role under `users_update_self`, with only a user in
 * context — there is no tenant here, because somebody with no membership at all
 * still has to be able to clear a forced change.
 *
 * The current password is required even on a forced first change. They have it,
 * it costs one field, and without it an unattended open tab is enough for
 * somebody else to take the account.
 */
export async function changeOwnPassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  const { verifyPassword } = await import('@/lib/password');

  const [row] = await withUserOnly(input.userId, (tx) =>
    tx
      .select({ passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, input.userId)),
  );
  if (!row) throw new UserAdminError('Signed out. Sign in again.', 401);

  if (!(await verifyPassword(row.passwordHash, input.currentPassword))) {
    throw new UserAdminError('That is not your current password.', 400);
  }

  const problem = checkPassword(input.newPassword, { currentPassword: input.currentPassword });
  if (problem) throw new UserAdminError(problem.message, 400);

  const passwordHash = await hashPassword(input.newPassword);
  await withUserOnly(input.userId, (tx) =>
    tx
      .update(schema.users)
      .set({ passwordHash, mustChangePassword: false, passwordUpdatedAt: new Date() })
      .where(eq(schema.users.id, input.userId)),
  );

  // Every other session, and this one too — the caller signs them back in, so
  // a stolen session cannot outlive the password it was obtained under.
  await destroyAllSessions(input.userId);
}
