import { and, eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { schema } from '@zeeraa/db';
import { canAdministerTenant } from '@zeeraa/core';
import { inngest } from '@zeeraa/jobs';
import { queryTenant, requireRole } from '@/lib/tenant';

/**
 * "Sync now" (§7, `sync.manual`).
 *
 * Sends the same event the nightly schedule sends, so a manual run is the
 * scheduled run triggered early rather than a second code path that can drift
 * from it. The durable steps a 90-day click backfill needs live in the Inngest
 * function; this route only asks for it.
 *
 * `zeeraa_admin` only, asserted here rather than relied on from the button
 * being hidden: the URL is typeable.
 */
const EVENTS: Record<string, string> = {
  google_ads: 'google-ads/sync.requested',
  salesforce: 'salesforce/sync.requested',
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenant: string }> },
): Promise<Response> {
  const { tenant: slug } = await params;
  const session = await requireRole(slug, canAdministerTenant);

  const platform = request.nextUrl.searchParams.get('platform') ?? '';
  const event = EVENTS[platform];
  if (!event) {
    return Response.json(
      { ok: false, error: `No connector for ${platform || 'an unnamed platform'}.` },
      { status: 400 },
    );
  }

  // The connection is read inside the tenant context, so a connection id from
  // another tenant resolves to nothing rather than to somebody else's row.
  const [connection] = await queryTenant(session, (tx) =>
    tx
      .select({ id: schema.connections.id, status: schema.connections.status })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.tenantId, session.tenant.id),
          eq(schema.connections.platform, platform),
        ),
      )
      .limit(1),
  );

  if (!connection) {
    return Response.json(
      { ok: false, error: `${platform} is not configured for this client.` },
      { status: 404 },
    );
  }

  try {
    await inngest.send({
      name: event,
      data: { tenantId: session.tenant.id, connectionId: connection.id, trigger: 'manual' },
    });
  } catch (error) {
    // Says what happened and what to do next, without apologising: until the
    // app is registered with Inngest there is nothing to receive the event, and
    // `run-scheduled` is the path that works today.
    return Response.json(
      {
        ok: false,
        error:
          'The sync queue did not accept the request. Until this deployment is registered ' +
          'with Inngest, run `pnpm --filter @zeeraa/jobs run-scheduled nightly` on a box ' +
          'that can reach the platforms.',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }

  return Response.json({ ok: true, queued: platform });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
