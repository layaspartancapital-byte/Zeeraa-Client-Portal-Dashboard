import type { NextRequest } from 'next/server';
import { runIncrementalSync } from '@zeeraa/jobs';
import { refuseUnlessCron } from '@/lib/cron-auth';

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
async function handle(request: NextRequest): Promise<Response> {
  const refused = refuseUnlessCron(request, 'sync');
  if (refused) return refused;

  // Salesforce has its own ten-minute schedule (`/api/cron/salesforce`); the
  // hourly run is the ad platforms and the organic sources.
  const result = await runIncrementalSync({
    trigger: 'cron-hourly',
    platforms: ['google_ads', 'meta', 'ga4', 'search_console'],
  });

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
