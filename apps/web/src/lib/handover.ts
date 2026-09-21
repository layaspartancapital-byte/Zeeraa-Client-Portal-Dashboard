import 'server-only';
import { cookies } from 'next/headers';

/**
 * The one-time password handover, carried in a cookie rather than in the URL.
 *
 * It used to travel as `?password=…` on the redirect after creating an account.
 * That worked — the card rendered and the password was on screen — but a
 * credential in a query string is written down in three places nobody cleans:
 * the browser's history, the deployment's access logs (Vercel records the
 * request path), and the `Referer` of any link followed from that page. It also
 * made the card's own promise false: "shown once" is not true of something
 * sitting in history.
 *
 * A cookie is read by the server, never logged with the path, and can be
 * cleared deliberately. `httpOnly` keeps it away from any script on the page.
 *
 * The 15-minute expiry is a backstop for an admin who closes the tab, not the
 * mechanism — `dismiss` is. A handover that vanished on its own while somebody
 * was still copying it would send them to reset the password again.
 */

const COOKIE = 'zeeraa_handover';
const TTL_SECONDS = 15 * 60;

export type Handover = {
  kind: 'created' | 'reset';
  email: string;
  password: string;
};

function pathFor(slug: string): string {
  return `/${slug}/people`;
}

/** Must be called from a Server Action; a page render may not set cookies. */
export async function setHandover(slug: string, handover: Handover): Promise<void> {
  (await cookies()).set({
    name: COOKIE,
    value: JSON.stringify(handover),
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    // Scoped to the one screen that displays it, so it is not attached to
    // every other request the browser makes in the meantime.
    path: pathFor(slug),
    maxAge: TTL_SECONDS,
  });
}

export async function readHandover(): Promise<Handover | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Handover>;
    if (!parsed.password || !parsed.email || !parsed.kind) return null;
    return parsed as Handover;
  } catch {
    // A malformed cookie is not worth an error page; it means no handover.
    return null;
  }
}

export async function clearHandover(slug: string): Promise<void> {
  (await cookies()).set({
    name: COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: pathFor(slug),
    maxAge: 0,
  });
}
