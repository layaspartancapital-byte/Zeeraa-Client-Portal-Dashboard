import { signOut } from '@/auth';

export const metadata = { title: 'Sign out · Zeeraa' };

export default function SignOutPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="font-display text-[24px] text-ink">Sign out</h1>
      <p className="mt-2 text-[13px] text-graphite">
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
          className="rounded-[4px] bg-night px-3 py-2 text-[13px] text-paper"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}
