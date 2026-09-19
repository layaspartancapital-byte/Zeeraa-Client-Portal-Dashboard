import { assetDownloadUrl, errorResponse } from '@/lib/assets';
import { requireTenant } from '@/lib/tenant';

/**
 * The only way to reach an object in the bucket.
 *
 * Nothing in this product ever renders a storage URL. The asset row is read
 * inside the tenant's row level security context — which is the authorisation
 * check, not a filter in front of one — and only then is a signed URL produced,
 * for this request, expiring in minutes. `no-store` keeps the redirect out of
 * every cache between here and the browser; a cached signed URL is a signed URL
 * somebody else can follow.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ tenant: string; assetId: string }> },
): Promise<Response> {
  const { tenant: slug, assetId } = await params;
  const session = await requireTenant(slug);

  try {
    const { url } = await assetDownloadUrl(session, assetId);
    return new Response(null, {
      status: 307,
      headers: { Location: url, 'Cache-Control': 'no-store, private' },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
