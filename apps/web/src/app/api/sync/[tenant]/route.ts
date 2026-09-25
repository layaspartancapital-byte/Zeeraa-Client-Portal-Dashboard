import type { NextRequest } from 'next/server';
import { canSyncNow } from '@zeeraa/core';
import { runManualSync, type SyncPlatform } from '@zeeraa/jobs';
import { requireRole } from '@/lib/tenant';

/**
 * "Sync now", for every member of the tenant (`canSyncNow`), clients included
 * since 25 September 2026.
 *
 * The member's session decides only *which* tenant — the one they are signed
 * in to, from their membership, never from anything else in the request — and
 * `runManualSync` does the rest as the ingestion role, at most once per tenant
 * every five minutes. A refusal is 429 with the sentence the button shows.
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
  // Asserted here rather than relied on from the button being shown: the URL
  // is typeable. `requireRole` resolves the tenant from the viewer's own
  // memberships, so a slug they do not belong to never reaches the sync.
  const session = await requireRole(slug, canSyncNow);

  const requested = request.nextUrl.searchParams.get('platform');
  if (requested && !PLATFORMS.includes(requested as SyncPlatform)) {
    return Response.json(
      { ok: false, error: `No connector for "${requested}".` },
      { status: 400 },
    );
  }

  const outcome = await runManualSync({
    tenantId: session.tenant.id,
    platforms: requested ? [requested as SyncPlatform] : undefined,
  });
  if (outcome.status === 'throttled') {
    return Response.json(
      { ok: false, throttled: true, error: outcome.message, nextAt: outcome.nextAt.toISOString() },
      { status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil((outcome.nextAt.getTime() - Date.now()) / 1000))) } },
    );
  }
  if (outcome.status === 'running') {
    return Response.json({ ok: false, throttled: true, error: outcome.message }, { status: 429 });
  }
  const { result } = outcome;

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
