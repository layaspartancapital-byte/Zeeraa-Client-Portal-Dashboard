import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { runIncrementalSync } from '@zeeraa/jobs';

/**
 * The hourly incremental sync, driven by Vercel Cron.
 *
 * Cron sends `Authorization: Bearer $CRON_SECRET` when that variable is set on
 * the project, so the same check serves both the scheduler and anybody who
 * finds the URL. Without it this endpoint would let a stranger cost the client
 * their API quota, so a missing `CRON_SECRET` refuses rather than defaults
 * open — an unauthenticated sync endpoint that works is worse than one that
 * does not.
 *
 * It answers 200 with the per-platform outcomes even when a unit failed, and
 * 207 when something did: Vercel retries nothing, and the useful record of a
 * failed sync is the `sync_runs` row plus this body, not a 500 with no detail.
 */
function authorised(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const offered = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  // Constant-time, and length-guarded because timingSafeEqual throws on a
  // length mismatch rather than returning false.
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(request: NextRequest): Promise<Response> {
  if (!process.env.CRON_SECRET) {
    console.error('[cron/sync] refused: CRON_SECRET is not set on this deployment');
    return Response.json(
      { ok: false, error: 'CRON_SECRET is not configured on this deployment.' },
      { status: 503 },
    );
  }
  if (!authorised(request)) {
    // 404 rather than 401: an endpoint that must not be reachable should not
    // confirm that it exists.
    return new Response('Not found', { status: 404 });
  }

  const result = await runIncrementalSync({ trigger: 'cron-hourly' });

  for (const outcome of result.outcomes) {
    const line = `[cron/sync] ${outcome.platform} ${outcome.tenantId.slice(0, 8)} ${outcome.status}: ${outcome.detail}`;
    if (outcome.status === 'failed') console.error(line);
    else console.warn(line);
  }

  return Response.json(result, { status: result.ok ? 200 : 207 });
}

export async function GET(request: NextRequest): Promise<Response> {
  return handle(request);
}

/** Cron issues GET; POST is here so the schedule can be exercised by hand. */
export async function POST(request: NextRequest): Promise<Response> {
  return handle(request);
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** The runner stops starting new work at 45s, inside this. */
export const maxDuration = 60;
