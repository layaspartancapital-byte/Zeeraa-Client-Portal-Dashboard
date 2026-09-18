import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { ingestCallEvents } from '@zeeraa/jobs';

/**
 * Aloware posts call events here as they happen.
 *
 * The CSV import carries the history; this carries everything after it. Both
 * routes go through the same normaliser and upsert on Aloware's Communication
 * ID, so a call delivered by both — which happens at the seam of every export
 * — is one row, and a re-delivery costs nothing.
 *
 * **Idempotent by construction, not by bookkeeping.** Aloware retries on any
 * non-2xx and occasionally re-sends anyway. There is no "have I seen this
 * before" lookup because there does not need to be one: the upsert key is the
 * vendor's own id, so a second delivery overwrites the first with the same
 * values. That is also why a duplicate answers 200 rather than 409 — a webhook
 * sender treats a 409 as a failure and retries it forever.
 *
 * Authentication is the cron route's pattern: a bearer secret, compared in
 * constant time, refusing closed when unset. A webhook that accepts unsigned
 * posts is a way for a stranger to write call records into a client's numbers.
 */
function authorised(request: NextRequest): boolean {
  const secret = process.env.ALOWARE_WEBHOOK_SECRET;
  if (!secret) return false;

  const offered = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  // Length-guarded: timingSafeEqual throws on a length mismatch rather than
  // returning false.
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenant: string }> },
): Promise<Response> {
  if (!process.env.ALOWARE_WEBHOOK_SECRET) {
    console.error('[aloware] refused: ALOWARE_WEBHOOK_SECRET is not set on this deployment');
    return Response.json(
      { ok: false, error: 'ALOWARE_WEBHOOK_SECRET is not configured on this deployment.' },
      { status: 503 },
    );
  }
  if (!authorised(request)) {
    // 404 rather than 401: an endpoint that must not be reachable should not
    // confirm that it exists.
    return new Response('Not found', { status: 404 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Body is not JSON.' }, { status: 400 });
  }

  /*
   * One event or a batch, because Aloware sends either depending on how the
   * subscription is configured — and a shape mismatch here would silently drop
   * a day of calls rather than fail loudly.
   */
  const records: Record<string, unknown>[] = Array.isArray(payload)
    ? (payload as Record<string, unknown>[])
    : Array.isArray((payload as { data?: unknown } | null)?.data)
      ? (payload as { data: Record<string, unknown>[] }).data
      : [payload as Record<string, unknown>];

  const { tenant: slug } = await params;
  const result = await ingestCallEvents(slug, records);
  if (!result) return new Response('Not found', { status: 404 });

  /*
   * 200 even when every record was rejected.
   *
   * A rejected record is not a delivery failure — an SMS event posted to a
   * call endpoint is the subscription being broader than this endpoint, and
   * retrying it forever helps nobody. The body says what happened, and the
   * counts are logged so a systematic rejection is visible rather than a quiet
   * gap in the call record.
   */
  if (result.rejected.length > 0) {
    console.warn(
      `[aloware] ${slug}: accepted ${result.accepted}, rejected ${result.rejected
        .map((r) => `${r.count} ${r.reason}`)
        .join(', ')}`,
    );
  }

  return Response.json({ ok: true, ...result }, { status: 200 });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
