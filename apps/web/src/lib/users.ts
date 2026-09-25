import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, withUserOnly } from '@zeeraa/db';
import {
  assignableRoles,
  canManageUsers,
  checkPassword,
  type Role,
} from '@zeeraa/core';
import { recordAccountAction } from '@/lib/audit';
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
  /** The last page view recorded in this tenant; null where none has been. */
  lastSeenAt: Date | null;
  lastPath: string | null;
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
        lastSeenAt: schema.userActivity.lastSeenAt,
        lastPath: schema.userActivity.lastPath,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      // Admitted to a Zeeraa admin only (0040); anybody else reads nulls.
      .leftJoin(
        schema.userActivity,
        and(
          eq(schema.userActivity.tenantId, schema.memberships.tenantId),
          eq(schema.userActivity.userId, schema.memberships.userId),
        ),
      )
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

/** The refusal raised by the last-Zeeraa-admin triggers, through any wrappers. */
function isLastZeeraaAdmin(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth += 1) {
    if (typeof e === 'object' && 'message' in e && /last Zeeraa admin/.test(String((e as { message?: unknown }).message))) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

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

export type GrantOutcome = { email: string; alreadyHadAccess: boolean };

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
          `An account already exists for ${email}. Use "Add an existing account" ` +
            'to give it access here rather than creating a second one — including ' +
            'when their access was removed earlier.',
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

    await recordAccountAction(tx, session, {
      action: 'create_account',
      subjectUserId: userId,
      subjectEmail: email,
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
): Promise<GrantOutcome> {
  assertMayManage(session);
  assertMayGrant(session, input.role);
  const email = input.email.trim().toLowerCase();

  return queryTenant(session, async (tx) => {
    const [user] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));

    /**
     * Two policies decide what this lookup can see, and between them they cover
     * everybody an admin here may act on: `users_visible_within_tenant` admits
     * this tenant's own people, and `users_admin_resolve_unattached` (0019)
     * admits an account that belongs to no tenant at all.
     *
     * What stays invisible is an account that belongs to a *different*
     * engagement — that is another client's roster, and it is hidden from a
     * Zeeraa admin for the same reason it is hidden from a client admin. The
     * message says so rather than claiming the address is unknown, because it
     * is reachable: `scripts/grant-membership.ts`, on the maintenance
     * connection.
     *
     * Before 0019 this branch also caught accounts attached to nothing, which
     * made a removed member unreachable: create refused because the address was
     * taken, and this refused because it could not see them.
     */
    if (!user) {
      throw new UserAdminError(
        `No account for ${email} that this engagement can reach. If they have ` +
          'never had one, create it above. If the address belongs to another ' +
          'engagement, a Zeeraa admin has to move it.',
        404,
      );
    }

    const inserted = await tx
      .insert(schema.memberships)
      .values({ userId: user.id, tenantId: session.tenant.id, role: input.role })
      .onConflictDoNothing()
      .returning({ id: schema.memberships.id });

    if (inserted.length > 0) {
      await recordAccountAction(tx, session, {
        action: 'grant_access',
        subjectUserId: user.id,
        subjectEmail: email,
        role: input.role,
      });
    }

    // Nothing inserted means the membership was already there. Saying "now has
    // access" would be true and useless; an admin who typed an address twice
    // should be told that is what happened.
    return { email, alreadyHadAccess: inserted.length === 0 };
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
  // Your own password changes through the change-password flow, which asks for
  // the current one; the database refuses a self-reset anyway (0028).
  if (userId === session.viewer.userId) {
    throw new UserAdminError('Change your own password from the change-password screen.', 400);
  }

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
    await recordAccountAction(tx, session, {
      action: 'reset_password',
      subjectUserId: userId,
      subjectEmail: row.email,
    });
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

  const removed = await queryTenant(session, async (tx) => {
    // Read before the delete: once the membership is gone the account shares
    // no tenant with this admin, and `users_visible_within_tenant` hides it.
    const [person] = await tx
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    if (!person) return [];
    const rows = await tx
      .delete(schema.memberships)
      .where(
        and(
          eq(schema.memberships.userId, userId),
          eq(schema.memberships.tenantId, session.tenant.id),
        ),
      )
      .returning({ userId: schema.memberships.userId, role: schema.memberships.role });
    if (rows.length > 0) {
      await recordAccountAction(tx, session, {
        action: 'remove_access',
        subjectUserId: userId,
        subjectEmail: person.email,
        role: rows[0]!.role,
      });
    }
    return rows;
  }).catch((error: unknown) => {
    // `memberships_protect_last_zeeraa_admin` (0027): a tenant always keeps
    // one Zeeraa admin, or nobody can administer it.
    if (isLastZeeraaAdmin(error)) {
      throw new UserAdminError(
        'This is the last Zeeraa admin on this engagement. Grant another Zeeraa admin access first.',
        409,
      );
    }
    throw error;
  });
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
 * Runs on the application role under `users_change_own_password` (0028), with
 * only a user in context — there is no tenant here, because somebody with no
 * membership at all still has to be able to clear a forced change. That policy
 * admits the update only while this transaction is marked
 * `app.password_change`, and `users_guard_own_account_row` holds it to a new
 * hash and nothing else: this is the one way anybody's own row changes.
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
  const updated = await withUserOnly(input.userId, async (tx) => {
    // Transaction-local, so it ends with this update and cannot leak across
    // pooled requests. Set only here, after the current password is verified.
    await tx.execute(sql`select set_config('app.password_change', 'on', true)`);
    return tx
      .update(schema.users)
      .set({ passwordHash, mustChangePassword: false, passwordUpdatedAt: new Date() })
      .where(eq(schema.users.id, input.userId))
      .returning({ id: schema.users.id });
  });
  // Under FORCE a refused update matches nothing and raises nothing; a password
  // change that silently did not happen is the worst outcome here.
  if (updated.length !== 1) throw new UserAdminError('Your password could not be changed.', 500);

  // Every other session, and this one too — the caller signs them back in, so
  // a stolen session cannot outlive the password it was obtained under.
  await destroyAllSessions(input.userId);
}
