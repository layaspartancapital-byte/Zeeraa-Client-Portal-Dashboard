import { redirect } from 'next/navigation';
import { signIn } from '@/auth';
import { getViewer } from '@/lib/tenant';

export const metadata = { title: 'Sign in · Zeeraa' };

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const viewer = await getViewer();
  if (viewer) redirect('/');
  const { next, error } = await searchParams;
  const redirectTo = next && next.startsWith('/') ? next : '/';

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <p className="text-[12px] text-graphite">Zeeraa</p>
      <h1 className="mt-1 font-display text-[28px] leading-tight text-ink">
        Performance platform
      </h1>
      <p className="mt-2 max-w-prose text-[13px] leading-relaxed text-graphite">
        Access is granted per client engagement. Sign in with the address your
        invitation was sent to.
      </p>

      {error && (
        <p className="mt-5 border-l-2 border-shortfall py-1 pl-3 text-[12px] leading-relaxed text-ink">
          That sign-in link did not work. Links expire after use and after 24 hours —
          request a new one below.
        </p>
      )}

      <form
        className="mt-8"
        action={async (formData: FormData) => {
          'use server';
          await signIn('resend', { email: String(formData.get('email') ?? ''), redirectTo });
        }}
      >
        <label htmlFor="email" className="block text-[12px] text-graphite">
          Work email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="mt-1.5 w-full rounded-[4px] border border-rule bg-surface px-3 py-2 text-[14px] text-ink"
        />
        <button
          type="submit"
          className="mt-3 w-full rounded-[4px] bg-night px-3 py-2 text-[13px] text-paper transition-opacity hover:opacity-90"
        >
          Email me a sign-in link
        </button>
      </form>

      <div className="my-6 flex items-center gap-3 text-[11px] text-graphite">
        <span className="h-px flex-1 bg-rule" />
        or
        <span className="h-px flex-1 bg-rule" />
      </div>

      <form
        action={async () => {
          'use server';
          await signIn('google', { redirectTo });
        }}
      >
        <button
          type="submit"
          className="w-full rounded-[4px] border border-rule bg-surface px-3 py-2 text-[13px] text-ink transition-colors hover:bg-paper"
        >
          Continue with Google
        </button>
      </form>
    </div>
  );
}
