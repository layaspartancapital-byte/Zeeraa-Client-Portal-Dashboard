import 'server-only';
import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { and, eq, gt, sql } from 'drizzle-orm';
import { getAuthDb, schema } from '@zeeraa/db';

/**
 * Sessions: a row in `sessions`, named by an opaque cookie.
 *
 * Held in the database rather than signed into a cookie, because revoking
 * access has to take effect on the next request. A JWT cannot be withdrawn —
 * it is valid until it expires — and this product hands out initial passwords
 * over chat and lets admins reset them, so "end every session that person
 * holds" is an operation that has to actually do something.
 *
 * These queries run on `zeeraa_auth`, the role that reaches identity tables and
 * nothing else. They have to: a sign-in happens before any tenant exists in the
 * request, so it cannot satisfy a policy that asks which tenant is current.
 */

const COOKIE = 'zeeraa_session';
const TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type SessionUser = {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  mustChangePassword: boolean;
};

/**
 * 256 bits from the CSPRNG. This is a bearer credential — whoever holds it is
 * the user — so it carries no structure to guess at and no meaning to decode.
 */
function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function createSession(userId: string): Promise<void> {
  const token = newToken();
  const expires = new Date(Date.now() + TTL_MS);
  await getAuthDb().insert(schema.sessions).values({ sessionToken: token, userId, expires });

  (await cookies()).set({
    name: COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    // Lax rather than strict: a link from a chat message into the dashboard is
    // the normal way somebody arrives, and strict would land them on a sign-in
    // page they are already past.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires,
  });
}

/**
 * The signed-in user, or null.
 *
 * One round trip, joined rather than two queries, and it re-reads
 * `must_change_password` every time — a forced change that could be escaped by
 * holding a session open would not be forced.
 */
export async function readSession(): Promise<SessionUser | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;

  const [row] = await getAuthDb()
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      image: schema.users.image,
      mustChangePassword: schema.users.mustChangePassword,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(
      and(
        eq(schema.sessions.sessionToken, token),
        // Expiry is enforced in the query, not by trusting the cookie's own
        // `expires` — a cookie's lifetime is a hint the browser may ignore and
        // a caller may forge.
        gt(schema.sessions.expires, new Date()),
      ),
    );

  return row ?? null;
}

/** Ends this session and clears the cookie. */
export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) {
    await getAuthDb().delete(schema.sessions).where(eq(schema.sessions.sessionToken, token));
  }
  jar.delete(COOKIE);
}

/**
 * Ends every session a user holds.
 *
 * Called when a password changes, by the owner or by an admin. A password reset
 * that left the old sessions alive would not be a reset — whoever was using the
 * compromised password would still be signed in.
 */
export async function destroyAllSessions(userId: string): Promise<number> {
  const rows = await getAuthDb()
    .delete(schema.sessions)
    .where(eq(schema.sessions.userId, userId))
    .returning({ token: schema.sessions.sessionToken });
  return rows.length;
}

/**
 * Deletes sessions that have already expired.
 *
 * Nothing serves an expired session — `readSession` filters on `expires` — so
 * this is housekeeping rather than a control. Called opportunistically on
 * sign-in so the table does not grow without bound in a product with no cron
 * job for it.
 */
export async function pruneExpiredSessions(): Promise<void> {
  await getAuthDb().delete(schema.sessions).where(sql`${schema.sessions.expires} < now()`);
}
