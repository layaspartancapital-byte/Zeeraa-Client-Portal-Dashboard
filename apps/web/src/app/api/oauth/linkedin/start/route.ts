import { NextResponse, type NextRequest } from 'next/server';
import { beginLinkedInConnect } from '@/lib/linkedin-oauth';

/**
 * Connect LinkedIn: `GET /api/oauth/linkedin/start?tenant=<slug>`, from the
 * button on Connections. A Zeeraa admin only; anybody else is redirected by
 * `requireRole` before a state is issued.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const slug = request.nextUrl.searchParams.get('tenant') ?? '';
  if (!/^[a-z0-9-]+$/.test(slug)) return new Response('Unknown client.', { status: 400 });
  const url = await beginLinkedInConnect(slug, request.nextUrl.origin);
  return NextResponse.redirect(url);
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
