import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getAuthDb, schema } from '@zeeraa/db';
import { getViewer } from '@/lib/tenant';
import { verifyPassword } from '@/lib/password';
import { createSession, pruneExpiredSessions } from '@/lib/session';
import { AuthShell } from '@/components/shell/AuthShell';

export const metadata = { title: 'Sign in · Zeeraa' };

/**
 * Sign-in: an address and a password, and nothing else.
 *
 * There is no "forgot password" link and no "create account" link, because
 * there is no email and no self-registration. Somebody who cannot get in asks
 * the person who gave them the account, and that is stated on the page rather
 * than left to be discovered.
 */
export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const viewer = await getViewer();
  if (viewer) redirect(viewer.mustChangePassword ? '/change-password' : '/');

  const { next, error } = await searchParams;
  // Only a path on this origin. `//evil.test` is a protocol-relative URL that a
  // browser resolves off-site, so the second character is checked as well.
  const redirectTo = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';

  async function signIn(formData: FormData): Promise<void> {
    'use server';
    const email = String(formData.get('email') ?? '').trim().toLowerCase();
    const password = String(formData.get('password') ?? '');

    const [user] = await getAuthDb()
      .select({ id: schema.users.id, passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.email, email));

    /**
     * One message for every failure, and the hash is computed even when the
     * account does not exist.
     *
     * "No account for that address" versus "wrong password" is a membership
     * oracle, and in a product where accounts are handed out by an admin, the
     * list of addresses that hold one is worth having. `verifyPassword` takes
     * a null hash and spends the same time on it, so the timing does not say
     * what the message declines to.
     */
    if (!(await verifyPassword(user?.passwordHash, password))) {
      redirect(`/signin?error=1${next ? `&next=${encodeURIComponent(next)}` : ''}`);
    }

    await pruneExpiredSessions();
    await createSession(user!.id);
    redirect(redirectTo);
  }

  return (
    <AuthShell footnote="Accounts are created by your account director. If you do not have one, ask them.">
      {/* The wordmark above the card says Zeeraa, so the card does not. */}
      <h1 className="text-[22px] font-semibold leading-tight text-text">Performance platform</h1>

      {error && (
        <p
          role="alert"
          className="mt-5 rounded-[8px] border border-[#FECDCA] bg-down-soft px-3 py-2 text-[13px] leading-relaxed text-[#B42318]"
          >
            That email and password do not match an account.
          </p>
        )}

        <form className="mt-6 space-y-4" action={signIn}>
          <div>
            <label htmlFor="email" className="block text-[13px] font-medium text-text-2">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="username"
              autoFocus
              className="mt-1.5 h-9 w-full rounded-[8px] border border-border bg-surface px-3 text-[14px] text-text"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-[13px] font-medium text-text-2">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="mt-1.5 h-9 w-full rounded-[8px] border border-border bg-surface px-3 text-[14px] text-text"
            />
          </div>

          <button
            type="submit"
            className="h-9 w-full rounded-[8px] bg-primary px-3 text-[13px] font-semibold text-white transition-colors hover:bg-primary-600"
          >
            Sign in
          </button>
        </form>
    </AuthShell>
  );
}
