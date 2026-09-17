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
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="font-display text-[24px] text-ink">No engagement on this account</h1>
      <p className="mt-2 max-w-prose text-[13px] leading-relaxed text-graphite">
        You are signed in as{' '}
        <span className="mono text-ink">{viewer?.email ?? 'an unknown address'}</span>, which is not
        attached to a client engagement. Invitations are issued per address; if yours went to a
        different one, sign in with that address instead.
      </p>
      <a href="/signout" className="mt-6 text-[13px] text-brass underline underline-offset-2">
        Sign out
      </a>
    </div>
  );
}
