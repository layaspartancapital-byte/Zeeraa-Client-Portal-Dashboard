import type { NextRequest } from 'next/server';
import { canAdministerTenant } from '@zeeraa/core';
import { runIncrementalSync, type SyncPlatform } from '@zeeraa/jobs';
import { requireRole } from '@/lib/tenant';

/**
 * "Sync now", for `zeeraa_admin`.
 *
 * Runs the same `runIncrementalSync` the hourly cron runs, scoped to one tenant
 * and optionally one platform, and waits for it so the button can report what
 * actually happened. It used to send an Inngest event and answer immediately,
 * which meant the button reported that it had queued something and never
 * reported whether the sync worked — and when the Inngest endpoint was
 * misconfigured, nothing reported anything at all.
 *
 * Deliberately the incremental path and not the backfill. A 90-day re-pull
 * does not fit in a serverless function; `scripts/run-scheduled.ts` and the
 * per-platform scripts remain the way to do that, from a machine with no
 * request timeout.
 */
const PLATFORMS: SyncPlatform[] = [
  'google_ads',
  'meta',
  'ga4',
  'search_console',
  'salesforce',
];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenant: string }> },
): Promise<Response> {
  const { tenant: slug } = await params;
  // Asserted here rather than relied on from the button being hidden: the URL
  // is typeable, and this one spends the client's API quota.
  const session = await requireRole(slug, canAdministerTenant);

  const requested = request.nextUrl.searchParams.get('platform');
  if (requested && !PLATFORMS.includes(requested as SyncPlatform)) {
    return Response.json(
      { ok: false, error: `No connector for "${requested}".` },
      { status: 400 },
    );
  }

  const result = await runIncrementalSync({
    tenantId: session.tenant.id,
    platforms: requested ? [requested as SyncPlatform] : undefined,
    trigger: 'manual',
  });

  if (result.outcomes.length === 0) {
    return Response.json(
      {
        ...result,
        ok: false,
        error: requested
          ? `${requested} is not configured for this client.`
          : 'No platform is configured for this client.',
      },
      { status: 404 },
    );
  }

  return Response.json(result, { status: result.ok ? 200 : 207 });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
