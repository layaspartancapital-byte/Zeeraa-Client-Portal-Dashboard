import type { NextRequest } from 'next/server';
import { refuseUnlessCron } from '@/lib/cron-auth';
import { runNightlyRepull } from '@zeeraa/jobs';

/**
 * The nightly re-pull, driven by Vercel Cron once a day.
 *
 * Ninety days of paid-media spend and conversions and thirty-five of GA4 and
 * Search Console, upserted over what is stored, so a restatement lands and a
 * day the hourly run missed is read — see `runNightlyRepull`. Once a day works
 * on every Vercel plan; the hourly run is the one that needs a plan allowing
 * more.
 *
 * Authenticated exactly as `/api/cron/sync` is, and for the same reason: a
 * stranger must not be able to spend the client's API quota.
 */
async function handle(request: NextRequest): Promise<Response> {
  const refused = refuseUnlessCron(request, 'nightly');
  if (refused) return refused;

  const result = await runNightlyRepull({ trigger: 'cron-nightly', deadlineMs: 240_000 });
  for (const outcome of result.outcomes) {
    const line = `[cron/nightly] ${outcome.platform} ${outcome.tenantId.slice(0, 8)} ${outcome.status}: ${outcome.detail}`;
    if (outcome.status === 'failed') console.error(line);
    else console.warn(line);
  }
  return Response.json(result, { status: result.ok ? 200 : 207 });
}

export async function GET(request: NextRequest): Promise<Response> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  return handle(request);
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** The runner stops starting new work at 240s, inside this. */
export const maxDuration = 300;
