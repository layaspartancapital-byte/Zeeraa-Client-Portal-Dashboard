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
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-16 sm:px-6">
      <div className="card p-6 sm:p-8">
      <p className="text-[13px] font-medium text-text-2">Zeeraa</p>
      <h1 className="mt-1 text-[22px] font-semibold leading-tight text-text">
        Performance platform
      </h1>
      <p className="mt-2 text-[13px] leading-relaxed text-text-2">
        Access is granted per client engagement. Sign in with the address your
        invitation was sent to.
      </p>

      {error && (
        <p className="mt-5 rounded-[8px] border border-[#FECDCA] bg-down-soft px-3 py-2 text-[13px] leading-relaxed text-[#B42318]">
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
        <label htmlFor="email" className="block text-[13px] font-medium text-text-2">
          Work email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="mt-1.5 h-9 w-full rounded-[8px] border border-border bg-surface px-3 text-[14px] text-text"
        />
        <button
          type="submit"
          className="mt-3 h-9 w-full rounded-[8px] bg-primary px-3 text-[13px] font-semibold text-white transition-colors hover:bg-primary-600"
        >
          Email me a sign-in link
        </button>
      </form>

      <div className="my-6 flex items-center gap-3 text-[12px] text-text-3">
        <span className="h-px flex-1 bg-border" />
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
          className="h-9 w-full rounded-[8px] border border-border bg-surface px-3 text-[13px] font-semibold text-text transition-colors hover:bg-canvas"
        >
          Continue with Google
        </button>
      </form>
      </div>
    </div>
  );
}
