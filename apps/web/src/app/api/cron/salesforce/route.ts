import type { NextRequest } from 'next/server';
import { runIncrementalSync } from '@zeeraa/jobs';
import { refuseUnlessCron } from '@/lib/cron-auth';

/**
 * Salesforce, every ten minutes.
 *
 * Deals are what the client watches move — a deal funded at 17:03 was not on
 * the dashboard until the next hourly run, and the report beside it already
 * showed it. So the CRM reads on its own ten-minute schedule while the ad
 * platforms stay hourly (`/api/cron/sync`): spend does not change inside ten
 * minutes in a way anybody acts on, and the platforms' quotas are spent on the
 * hour. A run takes seconds; one still in flight makes the next stand down
 * (`salesforceRunInFlight`), so two never race for the watermark.
 */
async function handle(request: NextRequest): Promise<Response> {
  const refused = refuseUnlessCron(request, 'salesforce');
  if (refused) return refused;

  const result = await runIncrementalSync({ trigger: 'cron-salesforce', platforms: ['salesforce'] });
  for (const outcome of result.outcomes) {
    const line = `[cron/salesforce] ${outcome.tenantId.slice(0, 8)} ${outcome.status}: ${outcome.detail}`;
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
export const maxDuration = 60;
