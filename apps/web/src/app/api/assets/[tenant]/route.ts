import type { NextRequest } from 'next/server';
import { createAssetDraft, errorResponse } from '@/lib/assets';
import { requireTenant } from '@/lib/tenant';

/**
 * Creates the asset row and signs an upload for it.
 *
 * The browser then PUTs the file straight to S3 and calls
 * `/api/assets/{tenant}/{assetId}/submit`. The file does not pass through this
 * function: a serverless request body is capped at a few megabytes, and a
 * webinar recording is not.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenant: string }> },
): Promise<Response> {
  const { tenant: slug } = await params;
  const session = await requireTenant(slug);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: 'Expected a JSON body.' }, { status: 400 });
  }

  const file = body.file as { name?: string; mimeType?: string; sizeBytes?: number } | undefined;

  try {
    const target = await createAssetDraft(session, {
      type: String(body.type ?? ''),
      title: String(body.title ?? ''),
      commitmentKey: String(body.commitmentKey ?? ''),
      periodDay: String(body.periodDay ?? ''),
      description: body.description == null ? null : String(body.description),
      externalUrl: body.externalUrl == null ? null : String(body.externalUrl),
      supersedesAssetId: body.supersedesAssetId == null ? null : String(body.supersedesAssetId),
      file: file?.name
        ? {
            name: String(file.name),
            mimeType: String(file.mimeType ?? 'application/octet-stream'),
            sizeBytes: Number(file.sizeBytes ?? 0),
          }
        : null,
    });
    return Response.json({ ok: true, ...target }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
