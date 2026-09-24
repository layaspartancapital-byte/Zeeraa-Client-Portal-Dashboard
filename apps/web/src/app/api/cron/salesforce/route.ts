import type { NextRequest } from 'next/server';
import { runIncrementalSync, salesforceTenantsDue, type IncrementalResult } from '@zeeraa/jobs';
import { refuseUnlessCron } from '@/lib/cron-auth';

/**
 * Salesforce, every ten minutes while the desk is open and hourly otherwise.
 *
 * Deals are what the client watches move — a deal funded at 17:03 was not on
 * the dashboard until the next hourly run, and the report beside it already
 * showed it. So the CRM reads on its own ten-minute schedule while the ad
 * platforms stay hourly (`/api/cron/sync`): spend does not change inside ten
 * minutes in a way anybody acts on, and the platforms' quotas are spent on the
 * hour. A run takes seconds; one still in flight makes the next stand down
 * (`salesforceRunInFlight`), so two never race for the watermark.
 *
 * Outside a tenant's `lead_response_hours` the ten-minute read only kept Neon
 * awake: it suspends after five idle minutes, so a read every ten left it
 * running half of every night and weekend. `vercel.json` fires this every ten
 * minutes inside the UTC envelope of the desk's hours (13:00–22:59 UTC,
 * weekdays, which holds 9–6 Eastern in EDT and EST alike) and on the hour
 * outside it; `salesforceTenantsDue` then reads a tenant on the first tick of
 * each hour and on every tick while its desk is open. A tick with nobody due
 * does not sync at all.
 */
async function handle(request: NextRequest): Promise<Response> {
  const refused = refuseUnlessCron(request, 'salesforce');
  if (refused) return refused;

  const now = new Date();
  const due = await salesforceTenantsDue(now);
  const runs: IncrementalResult[] = [];
  for (const tenantId of due) {
    runs.push(
      await runIncrementalSync({ trigger: 'cron-salesforce', platforms: ['salesforce'], tenantId, now }),
    );
  }
  const result: IncrementalResult = {
    startedAt: now.toISOString(),
    durationMs: Date.now() - now.getTime(),
    ok: runs.every((r) => r.ok),
    outcomes: runs.flatMap((r) => r.outcomes),
  };
  if (due.length === 0) console.warn('[cron/salesforce] no tenant due: every desk is closed');
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
