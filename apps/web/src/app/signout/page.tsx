import { signOut } from '@/auth';

export const metadata = { title: 'Sign out · Zeeraa' };

export default function SignOutPage() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-16 sm:px-6">
      <div className="card p-6 sm:p-8">
      <h1 className="text-[22px] font-semibold text-text">Sign out</h1>
      <p className="mt-2 text-[13px] leading-relaxed text-text-2">
        This ends the session on this device. Sessions are held in the database, so
        it takes effect immediately.
      </p>
      <form
        className="mt-6"
        action={async () => {
          'use server';
          await signOut({ redirectTo: '/signin' });
        }}
      >
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
