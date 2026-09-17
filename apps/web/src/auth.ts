import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import Resend from 'next-auth/providers/resend';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { getAuthDb, schema } from '@zeeraa/db';

/**
 * Auth.js with database sessions.
 *
 * Database sessions rather than JWTs: when a client revokes someone's access
 * mid-engagement, that has to take effect on the next request, not whenever a
 * token happens to expire.
 *
 * The adapter runs on its own database role, which reaches the identity tables
 * and nothing else — sign-in happens before any tenant context exists, so it
 * cannot be made to pass the tenant policies (§5).
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(getAuthDb(), {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    sessionsTable: schema.sessions,
    verificationTokensTable: schema.verificationTokens,
  }),
  // Named explicitly: Auth.js v5 reads AUTH_SECRET, the brief specifies
  // NEXTAUTH_SECRET, and a silent disagreement between the two is an outage.
  secret: process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET,
  session: { strategy: 'database', maxAge: 60 * 60 * 24 * 14 },
  trustHost: true,
  pages: { signIn: '/signin', verifyRequest: '/signin/check-email', error: '/signin' },
  providers: [
    Resend({
      apiKey: process.env.RESEND_API_KEY,
      from: process.env.EMAIL_FROM ?? 'no-reply@zeeraa.com',
      name: 'Email',
    }),
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
  ],
  callbacks: {
    /**
     * Access is a membership row, not an email domain. A person who signs in
     * successfully but has no membership reaches a page that says so — they are
     * not silently dropped at the door, because the usual cause is an invitation
     * sent to a different address.
     */
    session({ session, user }) {
      if (session.user) session.user.id = user.id;
      return session;
    },
  },
});
