import { eq } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';
import { getAuthDb, schema } from '@zeeraa/db';

/**
 * A development sign-in link.
 *
 *   /api/dev-signin?email=admin@zeeraa.com
 *
 * Neither configured provider works on a local machine — email needs a Resend
 * key and Google needs an OAuth client — so without this the only way in is to
 * paste a session token into DevTools, which is a poor way to look at a screen.
 *
 * **It is not an authorization bypass.** It mints a real `sessions` row for a
 * seeded user through the same adapter tables Auth.js uses, and every request
 * afterwards is an ordinary authenticated request: row level security applies,
 * `memberships` decides which tenants that person can open, and a user with no
 * membership lands on `/no-access` exactly as they would in production. What it
 * skips is proving ownership of the mailbox, and nothing else.
 *
 * Three guards, because a route like this shipping would be serious:
 *
 *   1. It refuses when NODE_ENV is production.
 *   2. It refuses unless the auth database is on localhost — the same guard
 *      `scripts/dev-session.ts` uses. A deployed environment points at a hosted
 *      database, so this cannot be reached even if the first guard were wrong.
 *   3. It only ever signs in a user who already exists. It creates nobody, so
 *      it cannot invent access that a seed did not already grant.
 */

function refuse(reason: string): NextResponse {
  // 404 rather than 403: in an environment where this must not work, it should
  // not advertise that it exists.
  console.warn(`[dev-signin] refused: ${reason}`);
  return new NextResponse('Not found', { status: 404 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (process.env.NODE_ENV === 'production') {
    return refuse('NODE_ENV is production');
  }

  const authUrl = process.env.DATABASE_URL_AUTH ?? '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(authUrl)) {
    return refuse('the auth database is not local');
  }

  const email = request.nextUrl.searchParams.get('email') ?? 'admin@zeeraa.com';
  const next = request.nextUrl.searchParams.get('next') ?? '/';

  const db = getAuthDb();
  const [user] = await db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.email, email));

  if (!user) {
    return new NextResponse(
      `No user with email ${email}. Seed development users first:\n\n` +
        '  SEED_USERS=yes pnpm db:seed\n',
      { status: 404, headers: { 'content-type': 'text/plain' } },
    );
  }

  const sessionToken = `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  await db.insert(schema.sessions).values({ sessionToken, userId: user.id, expires });

  // Auth.js prefixes the cookie with `__Secure-` and marks it secure whenever it
  // is serving over https. A Codespaces forwarded URL is https while the local
  // one is not, so the name is decided by the request rather than assumed —
  // getting this wrong is exactly why pasting a cookie by hand did not work.
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const isSecure = (forwardedProto ?? request.nextUrl.protocol.replace(':', '')) === 'https';
  const cookieName = isSecure ? '__Secure-authjs.session-token' : 'authjs.session-token';

  const response = NextResponse.redirect(new URL(next, request.nextUrl.origin));
  response.cookies.set({
    name: cookieName,
    value: sessionToken,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isSecure,
    expires,
  });

  console.warn(`[dev-signin] signed in ${user.email} — development only`);
  return response;
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
