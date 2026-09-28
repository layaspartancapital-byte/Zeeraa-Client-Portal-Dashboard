import { NextResponse, type NextRequest } from 'next/server';
import { completeLinkedInConnect } from '@/lib/linkedin-oauth';

/**
 * Where LinkedIn sends the admin back — the redirect URL registered with the
 * app. Ends on the client's Connections page with the outcome in the query,
 * or on the sign-in page when the flow cannot be tied to a client.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const q = request.nextUrl.searchParams;
  const outcome = await completeLinkedInConnect(
    { code: q.get('code'), state: q.get('state'), error: q.get('error'), errorDescription: q.get('error_description') },
    request.nextUrl.origin,
  );
  if (!outcome.slug) return NextResponse.redirect(new URL('/signin', request.url));
  const to = new URL(`/${outcome.slug}/connections`, request.url);
  to.searchParams.set('linkedin', outcome.result);
  to.searchParams.set('detail', outcome.detail.slice(0, 300));
  return NextResponse.redirect(to);
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
