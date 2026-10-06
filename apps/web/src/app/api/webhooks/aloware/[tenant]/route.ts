import type { NextRequest } from 'next/server';
import { detectAlowareSender } from '@zeeraa/connectors';
import {
  credentialMatches,
  describeRequest,
  ingestCallEvents,
  recordWebhookDelivery,
} from '@zeeraa/jobs';

/**
 * Aloware posts call events here as they happen — through a Zap, and from
 * Aloware's own webhook, while the Zap is retired.
 *
 * The CSV import carries the history; this carries everything after it. Every
 * route goes through the same normaliser and upserts on Aloware's
 * Communication ID, so a call delivered by the Zap, by Aloware directly and by
 * the export is one row, and a re-delivery costs nothing.
 *
 * **Idempotent by construction, not by bookkeeping.** Aloware retries on any
 * non-2xx and occasionally re-sends anyway. There is no "have I seen this
 * before" lookup because there does not need to be one: the upsert key is the
 * vendor's own id, so a second delivery overwrites the first with the same
 * values. That is also why a duplicate answers 200 rather than 409 — a webhook
 * sender treats a 409 as a failure and retries it forever.
 *
 * Authentication is one secret, refusing closed when unset. The Zap sends it
 * as `Bearer`; Aloware's form offers Bearer and Basic and fills the header
 * itself, so either carries it (`credentialMatches`). A webhook that accepts
 * unsigned posts is a way for a stranger to write call records into a
 * client's numbers.
 *
 * **Every refusal says what it was sent**, minus the content: header names,
 * the credential's shape and the body's field paths, in the day's
 * `webhook_deliveries.samples` and in the log. The direct webhook was refused
 * on 24 September and nothing recorded why.
 */

/** Read once: the sender is decided by the body, and a refusal describes it. */
async function readBody(request: NextRequest): Promise<{ body: unknown; json: boolean }> {
  try {
    const text = await request.text();
    return { body: JSON.parse(text), json: true };
  } catch {
    return { body: null, json: false };
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenant: string }> },
): Promise<Response> {
  /*
   * The slug is resolved first because every exit below is worth recording.
   *
   * The refusals used to return before anything had been looked up, so a
   * deployment with no secret and a sender with the wrong one both left exactly
   * the trace an absent subscription leaves: nothing. Those two are the likely
   * causes of this endpoint's silence, and they were the two the database could
   * not name.
   */
  const { tenant: slug } = await params;
  const secret = process.env.ALOWARE_WEBHOOK_SECRET ?? null;
  const { body, json } = await readBody(request);
  const sender = detectAlowareSender(json ? body : null, request.headers.get('user-agent'));
  const fingerprint = () =>
    describeRequest({ headers: request.headers.entries(), url: request.url, body, json, secret });

  const record = (outcome: Parameters<typeof recordWebhookDelivery>[2]) =>
    // Awaited rather than floated: a serverless function is frozen the moment
    // the response resolves, and a dangling promise is a counter that lands
    // sometimes.
    recordWebhookDelivery(slug, 'aloware', outcome);

  const refuse = async (reason: string) => {
    const sample = fingerprint();
    // Redacted by construction: no header value but user agent and content
    // type, no body value but codes. Safe in a log, which Vercel keeps.
    console.warn(`[aloware] ${slug}: refused (${reason}) from ${sender}: ${JSON.stringify(sample)}`);
    await record({ kind: 'refused', reason, sender, sample });
  };

  if (!secret) {
    console.error('[aloware] refused: ALOWARE_WEBHOOK_SECRET is not set on this deployment');
    await refuse('ALOWARE_WEBHOOK_SECRET is not set');
    return Response.json(
      { ok: false, error: 'ALOWARE_WEBHOOK_SECRET is not configured on this deployment.' },
      { status: 503 },
    );
  }
  if (!credentialMatches(request.headers.get('authorization'), secret)) {
    /*
     * 404 rather than 401: an endpoint that must not be reachable should not
     * confirm that it exists. Counted all the same, per sender, with the
     * post's description — which is what turns "unauthenticated" into the
     * header it actually sent.
     */
    await refuse('unauthenticated');
    return new Response('Not found', { status: 404 });
  }

  if (!json) {
    await refuse('body is not JSON');
    return Response.json({ ok: false, error: 'Body is not JSON.' }, { status: 400 });
  }
  const payload = body;

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

  const result = await ingestCallEvents(slug, records, sender);
  if (!result) return new Response('Not found', { status: 404 });

  await record({
    kind: 'read',
    accepted: result.accepted,
    written: result.written,
    inserted: result.inserted,
    rejected: result.rejected,
    sender,
    // The accepted shape too, so a renamed field is a changed list, not a gap.
    sample: fingerprint(),
  });

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
      `[aloware] ${slug} (${sender}${result.shadow ? ', shadow' : ''}): accepted ${result.accepted}, rejected ${result.rejected
        .map((r) => `${r.count} ${r.reason}`)
        .join(', ')}`,
    );
  }

  return Response.json({ ok: true, ...result }, { status: 200 });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
