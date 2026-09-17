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

  // `?debug=1` reports what actually arrived rather than signing in. A tunnel
  // that rewrites Host and drops x-forwarded-proto looks identical from the
  // outside to a cookie the browser refused, and guessing between the two is
  // how this went wrong the first time.
  if (request.nextUrl.searchParams.get('debug')) {
    const seen = Object.fromEntries(request.headers.entries());
    return new NextResponse(
      JSON.stringify(
        {
          'request.url': request.url,
          'nextUrl.origin': request.nextUrl.origin,
          'nextUrl.protocol': request.nextUrl.protocol,
          host: seen.host ?? null,
          'x-forwarded-host': seen['x-forwarded-host'] ?? null,
          'x-forwarded-proto': seen['x-forwarded-proto'] ?? null,
          'x-forwarded-for': seen['x-forwarded-for'] ?? null,
          origin: seen.origin ?? null,
          referer: seen.referer ?? null,
        },
        null,
        2,
      ),
      { headers: { 'content-type': 'application/json' } },
    );
  }

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

  /**
   * A relative redirect, deliberately.
   *
   * `request.nextUrl.origin` is `http://localhost:3000` on every request the dev
   * server handles, whatever Host arrived — so an absolute redirect built from
   * it sends a browser on the forwarded URL to a localhost it cannot reach. A
   * relative Location is resolved by the browser against the origin it actually
   * used, which is the only origin that is certainly right.
   */
  const location = next.startsWith('/') ? next : `/${next}`;
  const response = new NextResponse(null, { status: 307, headers: { Location: location } });

  /**
   * Both cookie names, every time.
   *
   * Auth.js prefixes the session cookie with `__Secure-` and requires the Secure
   * attribute when it believes it is serving over https, and it decides that
   * from a mixture of AUTH_URL and the request headers. Through this tunnel
   * neither is reliable: `x-forwarded-proto` arrives as `http` even when the
   * browser is on https, and NEXTAUTH_URL here names localhost. So the answer is
   * not to guess which name Auth.js will read.
   *
   * Setting both costs nothing and cannot misfire. A browser on http silently
   * discards the Secure one; a browser on https keeps both and Auth.js finds
   * whichever it looks for. The `__Secure-` prefix is only honoured with
   * `secure: true`, which is why that one carries it unconditionally.
   *
   * Neither sets a Domain, so both are host-only — scoped to exactly the host
   * that served this response, which is the host the browser is on.
   */
  const shared = { value: sessionToken, httpOnly: true, sameSite: 'lax' as const, path: '/', expires };
  response.cookies.set({ ...shared, name: 'authjs.session-token', secure: false });
  response.cookies.set({ ...shared, name: '__Secure-authjs.session-token', secure: true });

  console.warn(`[dev-signin] signed in ${user.email} — development only`);
  return response;
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
