import { redirect } from 'next/navigation';
import { destroySession } from '@/lib/session';

export const metadata = { title: 'Sign out · Zeeraa' };

export default function SignOutPage() {
  async function signOut(): Promise<void> {
    'use server';
    await destroySession();
    redirect('/signin');
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-16 sm:px-6">
      <div className="card p-6 sm:p-8">
        <h1 className="text-[22px] font-semibold text-text">Sign out</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-text-2">
          This ends the session on this device. Sessions are rows in the database, so it takes
          effect immediately rather than when a token would have expired.
        </p>
        <form className="mt-6" action={signOut}>
          <button
            type="submit"
            className="h-9 rounded-[8px] bg-primary px-3 text-[13px] font-semibold text-white transition-colors hover:bg-primary-600"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
