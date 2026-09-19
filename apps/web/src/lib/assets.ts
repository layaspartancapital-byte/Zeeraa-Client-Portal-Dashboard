import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@zeeraa/db';
import {
  assetObjectKey,
  canApproveAssets,
  canUploadAssets,
  commitmentPeriodStart,
  deliveredAssetIds,
  hasCountableArtifacts,
  safeFileName,
  type CommitmentPeriod,
  type CountableAsset,
} from '@zeeraa/core';
import { supersedingAssetId } from '@/lib/asset-sql';
import { queryTenant, type TenantSession } from '@/lib/tenant';
import {
  headObject,
  signedDownloadUrl,
  signedUploadUrl,
  StorageNotConfiguredError,
} from '@/lib/storage';

/**
 * The write side of the workspace: upload, submit, decide, and the delivered
 * count that follows from a decision.
 *
 * Every function here runs inside `withTenant`, so row level security is the
 * boundary and the role checks below are the second of two. The one that
 * genuinely cannot be moved into the application is who may approve: that lives
 * in a trigger (migration 0013), because a delivered figure Zeeraa could raise
 * on its own behalf is not a compliance record. The checks in this file exist
 * to produce a decent error rather than a constraint violation.
 */

export class AssetError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AssetError';
  }
}

/* ------------------------------------------------------------------------- */
/* The delivered count                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Rewrites the derived delivery record for one commitment in one period.
 *
 * Upsert, never append — the same rule the nightly ingestion follows, for the
 * same reason: this runs on every decision, and an insert would leave one
 * commitment holding a row per approval and a delivered figure that climbed
 * with the number of times somebody clicked.
 *
 * Where the commitment has no artifact in front of the client at all, the row
 * is *removed* rather than written as zero. A commitment nobody has recorded
 * against and a commitment delivered zero times are different claims, and the
 * delivery screen is required to be able to tell them apart.
 *
 * Runs in the caller's transaction, so a decision and the count it changes
 * commit together or not at all.
 */
export async function recomputeDeliveredFromAssets(
  tx: Database,
  input: { tenantId: string; commitmentKey: string; periodStart: string },
): Promise<{ delivered: number | null; assetIds: string[] }> {
  const { tenantId, commitmentKey, periodStart } = input;

  const rows = await tx
    .select({
      id: schema.assets.id,
      status: schema.assets.status,
      supersededByAssetId: supersedingAssetId,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.tenantId, tenantId),
        eq(schema.assets.commitmentKey, commitmentKey),
        eq(schema.assets.periodStart, periodStart),
      ),
    );

  const assets: CountableAsset[] = rows.map((r) => ({
    id: r.id,
    status: r.status,
    supersededByAssetId: r.supersededByAssetId,
  }));

  if (!hasCountableArtifacts(assets)) {
    await tx
      .delete(schema.deliverableRecords)
      .where(
        and(
          eq(schema.deliverableRecords.tenantId, tenantId),
          eq(schema.deliverableRecords.commitmentKey, commitmentKey),
          eq(schema.deliverableRecords.periodStart, periodStart),
          eq(schema.deliverableRecords.source, 'derived_from_assets'),
        ),
      );
    return { delivered: null, assetIds: [] };
  }

  const assetIds = deliveredAssetIds(assets);

  await tx
    .insert(schema.deliverableRecords)
    .values({
      tenantId,
      commitmentKey,
      periodStart,
      deliveredQuantity: String(assetIds.length),
      source: 'derived_from_assets',
      notes: null,
      recordedByUserId: null,
    })
    .onConflictDoUpdate({
      target: [
        schema.deliverableRecords.tenantId,
        schema.deliverableRecords.commitmentKey,
        schema.deliverableRecords.periodStart,
        schema.deliverableRecords.source,
      ],
      set: {
        deliveredQuantity: String(assetIds.length),
        recordedAt: new Date(),
      },
    });

  return { delivered: assetIds.length, assetIds };
}

/* ------------------------------------------------------------------------- */
/* Upload                                                                     */
/* ------------------------------------------------------------------------- */

export type UploadTarget = {
  assetId: string;
  version: number;
  /** Null for an asset that is a URL rather than a file. */
  uploadUrl: string | null;
  key: string | null;
  expiresInSeconds: number | null;
};

export type CreateAssetInput = {
  type: string;
  title: string;
  commitmentKey: string;
  /** Any tenant-local day in the period; normalised to the period's first day. */
  periodDay: string;
  description?: string | null;
  file?: { name: string; mimeType: string; sizeBytes: number } | null;
  /** A live placement has no file, only where it went. */
  externalUrl?: string | null;
  /** Replacing a rejected or superseded version with a new one. */
  supersedesAssetId?: string | null;
};

/**
 * Writes the row first, then signs an upload for it.
 *
 * In that order deliberately. The key is derived from the asset id and its
 * version, so the row has to exist before the key does — which also means every
 * object in the bucket is attributable to a tenant, an uploader and a
 * commitment before a single byte is accepted. An upload that never completes
 * leaves a `draft` with no file, which is visible and harmless; bytes with no
 * row would be neither.
 */
export async function createAssetDraft(
  session: TenantSession,
  input: CreateAssetInput,
): Promise<UploadTarget> {
  if (!canUploadAssets(session.tenant.role)) {
    throw new AssetError('Uploading work into the workspace is Zeeraa-side.', 403);
  }
  if (!input.title.trim()) throw new AssetError('An asset needs a title.', 400);
  if (!input.file && !input.externalUrl?.trim()) {
    throw new AssetError('An asset needs either a file or a URL.', 400);
  }

  return queryTenant(session, async (tx) => {
    const commitment = await requireCommitment(tx, session.tenant.id, input.commitmentKey);
    await requireAssetType(tx, session.tenant.id, input.type);
    const periodStart = commitmentPeriodStart(
      commitment.period as CommitmentPeriod,
      input.periodDay,
    );

    let version = 1;
    if (input.supersedesAssetId) {
      const [previous] = await tx
        .select({ id: schema.assets.id, version: schema.assets.version })
        .from(schema.assets)
        .where(
          and(
            eq(schema.assets.tenantId, session.tenant.id),
            eq(schema.assets.id, input.supersedesAssetId),
          ),
        );
      if (!previous) throw new AssetError('There is no such asset to replace.', 404);
      version = previous.version + 1;
    }

    const [asset] = await tx
      .insert(schema.assets)
      .values({
        tenantId: session.tenant.id,
        type: input.type,
        title: input.title.trim(),
        description: input.description?.trim() || null,
        commitmentKey: commitment.key,
        periodStart,
        externalUrl: input.externalUrl?.trim() || null,
        fileName: input.file ? safeFileName(input.file.name) : null,
        mimeType: input.file?.mimeType ?? null,
        status: 'draft',
        version,
        supersedesAssetId: input.supersedesAssetId ?? null,
        uploadedByUserId: session.viewer.userId,
      })
      .returning({ id: schema.assets.id, version: schema.assets.version });

    if (!asset) throw new AssetError('The asset could not be created.', 500);

    if (!input.file) {
      await logActivity(tx, session, 'created', asset.id, { title: input.title });
      return {
        assetId: asset.id,
        version: asset.version,
        uploadUrl: null,
        key: null,
        expiresInSeconds: null,
      };
    }

    const key = assetObjectKey({
      tenantId: session.tenant.id,
      assetId: asset.id,
      version: asset.version,
      fileName: input.file.name,
    });

    const signed = await signedUploadUrl({
      tenantId: session.tenant.id,
      key,
      contentType: input.file.mimeType || 'application/octet-stream',
      sizeBytes: input.file.sizeBytes,
    });

    await tx
      .update(schema.assets)
      .set({ fileKey: key })
      .where(and(eq(schema.assets.tenantId, session.tenant.id), eq(schema.assets.id, asset.id)));

    await logActivity(tx, session, 'created', asset.id, { title: input.title });

    return {
      assetId: asset.id,
      version: asset.version,
      uploadUrl: signed.url,
      key,
      expiresInSeconds: signed.expiresInSeconds,
    };
  });
}

/**
 * Confirms the bytes arrived and puts the asset in front of the client.
 *
 * The size is read from S3 rather than taken from the browser: a client that
 * reports a successful upload is reporting what it hoped happened, and an asset
 * whose object is missing must not become something a delivered figure can rest
 * on. A file asset with no object stays `draft` and the caller is told why.
 */
export async function submitAsset(
  session: TenantSession,
  assetId: string,
): Promise<{ status: string }> {
  if (!canUploadAssets(session.tenant.role)) {
    throw new AssetError('Only Zeeraa may submit work for review.', 403);
  }

  return queryTenant(session, async (tx) => {
    const asset = await loadAsset(tx, session.tenant.id, assetId);

    if (asset.fileKey) {
      const object = await headObject({ tenantId: session.tenant.id, key: asset.fileKey });
      if (!object) {
        throw new AssetError(
          'The upload did not complete, so there is nothing to review yet. Try the upload again.',
          409,
        );
      }
      await tx
        .update(schema.assets)
        .set({ sizeBytes: object.sizeBytes, mimeType: asset.mimeType ?? object.mimeType })
        .where(and(eq(schema.assets.tenantId, session.tenant.id), eq(schema.assets.id, assetId)));
    }

    await tx
      .update(schema.assets)
      .set({ status: 'submitted', submittedAt: new Date() })
      .where(and(eq(schema.assets.tenantId, session.tenant.id), eq(schema.assets.id, assetId)));

    await logActivity(tx, session, 'submitted', assetId, { title: asset.title });
    await recomputeIfTagged(tx, session.tenant.id, asset);

    return { status: 'submitted' };
  });
}

/* ------------------------------------------------------------------------- */
/* The decision                                                              */
/* ------------------------------------------------------------------------- */

export type Decision = 'approve' | 'request_changes';

/**
 * The client's decision, and the delivered figure that follows from it.
 *
 * Both halves in one transaction: a delivered count that could be left behind
 * by a failed write would be a compliance record that disagrees with the
 * artifacts behind it.
 */
export async function decideAsset(
  session: TenantSession,
  assetId: string,
  decision: Decision,
  reason?: string | null,
): Promise<{ status: string; delivered: number | null }> {
  if (!canApproveAssets(session.tenant.role)) {
    throw new AssetError('Only a client admin may approve work or request changes.', 403);
  }
  if (decision === 'request_changes' && !reason?.trim()) {
    throw new AssetError('Sending work back needs a reason.', 400);
  }

  return queryTenant(session, async (tx) => {
    const asset = await loadAsset(tx, session.tenant.id, assetId);
    if (asset.status === 'draft') {
      throw new AssetError('That asset has not been submitted for review yet.', 409);
    }

    const now = new Date();
    if (decision === 'approve') {
      await tx
        .update(schema.assets)
        .set({
          status: 'approved',
          approvedByUserId: session.viewer.userId,
          approvedAt: now,
          changesRequestedReason: null,
        })
        .where(and(eq(schema.assets.tenantId, session.tenant.id), eq(schema.assets.id, assetId)));
    } else {
      await tx
        .update(schema.assets)
        .set({
          status: 'changes_requested',
          changesRequestedReason: reason!.trim(),
          changesRequestedByUserId: session.viewer.userId,
          changesRequestedAt: now,
          // An approval that was withdrawn is not an approval. Clearing these
          // keeps the row from claiming a sign-off that no longer holds.
          approvedByUserId: null,
          approvedAt: null,
        })
        .where(and(eq(schema.assets.tenantId, session.tenant.id), eq(schema.assets.id, assetId)));
    }

    await logActivity(tx, session, decision === 'approve' ? 'approved' : 'changes_requested', assetId, {
      title: asset.title,
      ...(decision === 'request_changes' ? { reason: reason!.trim() } : {}),
    });

    const recomputed = await recomputeIfTagged(tx, session.tenant.id, asset);
    return {
      status: decision === 'approve' ? 'approved' : 'changes_requested',
      delivered: recomputed,
    };
  });
}

/* ------------------------------------------------------------------------- */
/* Download                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * A signed URL for one asset, produced per request.
 *
 * The authorisation is the read itself: the row is fetched inside this tenant's
 * RLS context, so an asset belonging to another client returns nothing and this
 * throws a 404 before a signature exists. Nothing is cached and nothing is
 * stored — the link the browser follows is minutes old and single-purpose.
 */
export async function assetDownloadUrl(
  session: TenantSession,
  assetId: string,
): Promise<{ url: string; external: boolean }> {
  const asset = await queryTenant(session, (tx) => loadAsset(tx, session.tenant.id, assetId));

  if (!asset.fileKey) {
    if (asset.externalUrl) return { url: asset.externalUrl, external: true };
    throw new AssetError('That asset has no file.', 404);
  }

  const url = await signedDownloadUrl({
    tenantId: session.tenant.id,
    key: asset.fileKey,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
  });
  return { url, external: false };
}

/* ------------------------------------------------------------------------- */
/* Shared                                                                    */
/* ------------------------------------------------------------------------- */

type LoadedAsset = {
  id: string;
  title: string;
  status: string;
  commitmentKey: string | null;
  periodStart: string | null;
  fileKey: string | null;
  fileName: string | null;
  mimeType: string | null;
  externalUrl: string | null;
};

async function loadAsset(tx: Database, tenantId: string, assetId: string): Promise<LoadedAsset> {
  const [asset] = await tx
    .select({
      id: schema.assets.id,
      title: schema.assets.title,
      status: schema.assets.status,
      commitmentKey: schema.assets.commitmentKey,
      periodStart: schema.assets.periodStart,
      fileKey: schema.assets.fileKey,
      fileName: schema.assets.fileName,
      mimeType: schema.assets.mimeType,
      externalUrl: schema.assets.externalUrl,
    })
    .from(schema.assets)
    .where(and(eq(schema.assets.tenantId, tenantId), eq(schema.assets.id, assetId)));

  // Not "forbidden": row level security returned nothing, and this cannot tell
  // an asset in another tenant from one that never existed. Saying so would be
  // the difference.
  if (!asset) throw new AssetError('No such asset.', 404);
  return asset;
}

function recomputeIfTagged(
  tx: Database,
  tenantId: string,
  asset: LoadedAsset,
): Promise<number | null> {
  if (!asset.commitmentKey || !asset.periodStart) return Promise.resolve(null);
  return recomputeDeliveredFromAssets(tx, {
    tenantId,
    commitmentKey: asset.commitmentKey,
    periodStart: asset.periodStart,
  }).then((r) => r.delivered);
}

async function requireCommitment(
  tx: Database,
  tenantId: string,
  key: string,
): Promise<{ key: string; period: string; label: string }> {
  const [row] = await tx
    .select({
      key: schema.deliverableCommitments.key,
      period: schema.deliverableCommitments.period,
      label: schema.deliverableCommitments.label,
    })
    .from(schema.deliverableCommitments)
    .where(
      and(
        eq(schema.deliverableCommitments.tenantId, tenantId),
        eq(schema.deliverableCommitments.key, key),
      ),
    );
  // The commitment list is configuration, per tenant. An asset tagged to a key
  // this client has not committed to would produce a delivered figure against
  // a commitment that does not exist.
  if (!row) throw new AssetError('That is not a commitment configured for this client.', 400);
  return row;
}

async function requireAssetType(tx: Database, tenantId: string, key: string): Promise<void> {
  const [row] = await tx
    .select({ key: schema.assetTypes.key })
    .from(schema.assetTypes)
    .where(and(eq(schema.assetTypes.tenantId, tenantId), eq(schema.assetTypes.key, key)));
  if (!row) throw new AssetError('That is not an asset type configured for this client.', 400);
}

/**
 * The audit trail. Append-only at the database level (a restrictive policy
 * forbids update and delete), which is what makes it worth writing at all.
 *
 * The activity *rail* is collaboration and is not built. The record is not
 * optional: "we never signed off on that" is the dispute this workspace exists
 * to settle, and it is settled by rows, not by a feed.
 */
async function logActivity(
  tx: Database,
  session: TenantSession,
  verb: string,
  assetId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.insert(schema.activityLog).values({
    tenantId: session.tenant.id,
    actorUserId: session.viewer.userId,
    verb,
    objectType: 'asset',
    objectId: assetId,
    metadata,
  });
}

/**
 * One place that turns a failure into a response, so every asset endpoint
 * answers the same way.
 *
 * Unconfigured storage is a 503 carrying the missing variables, not a 500: it
 * is a dependency that has not been set up, which is a state this product
 * renders rather than an error it hides.
 */
export function errorResponse(error: unknown): Response {
  if (error instanceof StorageNotConfiguredError) {
    return Response.json({ ok: false, error: error.message }, { status: 503 });
  }
  if (error instanceof AssetError) {
    return Response.json({ ok: false, error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ ok: false, error: message }, { status: 500 });
}
