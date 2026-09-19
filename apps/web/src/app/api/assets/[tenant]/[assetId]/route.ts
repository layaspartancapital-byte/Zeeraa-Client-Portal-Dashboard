import type { NextRequest } from 'next/server';
import {
  AssetError,
  decideAsset,
  errorResponse,
  submitAsset,
  type Decision,
} from '@/lib/assets';
import { requireTenant } from '@/lib/tenant';

/**
 * Moving one asset through review.
 *
 * `submit` is Zeeraa's; `approve` and `request_changes` are the client's, and
 * that split is enforced by a trigger on `assets` as well as here — the button
 * being hidden is presentation, and the URL is typeable.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenant: string; assetId: string }> },
): Promise<Response> {
  const { tenant: slug, assetId } = await params;
  const session = await requireTenant(slug);

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* an action with no payload is fine */
  }

  const action = String(body.action ?? '');

  try {
    if (action === 'submit') {
      return Response.json({ ok: true, ...(await submitAsset(session, assetId)) });
    }
    if (action === 'approve' || action === 'request_changes') {
      const result = await decideAsset(
        session,
        assetId,
        action as Decision,
        body.reason == null ? null : String(body.reason),
      );
      return Response.json({ ok: true, ...result });
    }
    throw new AssetError(
      'Expected an action of "submit", "approve" or "request_changes".',
      400,
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
