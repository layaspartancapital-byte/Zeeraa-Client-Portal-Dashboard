import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';

/**
 * The gate every `/api/cron/*` route shares.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when the variable is
 * set on the project. A missing secret refuses (503) rather than defaulting
 * open — an unauthenticated endpoint that spends the client's API quota is
 * worse than one that does not run — and a wrong one answers 404, so the
 * route does not confirm that it exists.
 *
 * Returns the response to send when the request is refused, or null to go on.
 */
export function refuseUnlessCron(request: NextRequest, route: string): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error(`[cron/${route}] refused: CRON_SECRET is not set on this deployment`);
    return Response.json(
      { ok: false, error: 'CRON_SECRET is not configured on this deployment.' },
      { status: 503 },
    );
  }
  const offered = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  // Length-guarded: timingSafeEqual throws on a length mismatch.
  const ok = offered.length === expected.length && timingSafeEqual(offered, expected);
  return ok ? null : new Response('Not found', { status: 404 });
}
