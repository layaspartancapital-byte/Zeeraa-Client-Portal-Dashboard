import { getViewer } from '@/lib/tenant';

export const metadata = { title: 'No access · Zeeraa' };

/**
 * Signed in, but attached to no engagement. The usual cause is an invitation
 * sent to a different address, so the page says which address was used rather
 * than leaving someone to guess.
 */
export default async function NoAccess() {
  const viewer = await getViewer();

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-16 sm:px-6">
      <div className="card p-6 sm:p-8">
      <h1 className="text-[22px] font-semibold text-text">No engagement on this account</h1>
      <p className="mt-2 text-[13px] leading-relaxed text-text-2">
        You are signed in as{' '}
        <span className="font-medium text-text">{viewer?.email ?? 'an unknown address'}</span>, which is not
        attached to a client engagement. Invitations are issued per address; if yours went to a
        different one, sign in with that address instead.
      </p>
      <a href="/signout" className="mt-6 inline-block text-[13px] font-medium text-primary hover:text-primary-600">
        Sign out
      </a>
      </div>
    </div>
  );
}
