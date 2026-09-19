import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { isTenantScopedKey } from '@zeeraa/core';

/**
 * Asset storage, on S3.
 *
 * The rule this module exists to make unbreakable: **no object in this bucket
 * is public, and no URL to one is handed out that was not signed here, for a
 * caller whose access was checked first.** These are a client's unreleased
 * creatives and draft campaign assets; a guessable URL is a leak whether or not
 * anybody guesses it.
 *
 * Four things carry that, and none of them is sufficient alone:
 *
 *   1. The bucket blocks all public access and ACLs are disabled, so an object
 *      cannot be made readable by getting a header wrong.
 *   2. Keys are `tenant/{tenant_id}/…` and the IAM policy the application's
 *      credentials carry reaches `…/tenant/*` and nothing else — with no
 *      `s3:ListBucket`, so a leaked credential cannot enumerate what other
 *      tenants hold.
 *   3. `assertTenantKey` refuses a key belonging to another tenant before a
 *      signature is ever produced. The row that key came from was read through
 *      RLS, so this is the second of two checks rather than the first.
 *   4. Signed URLs are minutes long, and a download is a redirect produced per
 *      request, never a value stored on a row or embedded in a page.
 *
 * Uploads go from the browser straight to S3 against a presigned PUT, so a
 * 40 MB video never passes through a serverless function with a 4.5 MB request
 * body limit. The row is written first, in `draft`, which is what makes the key
 * derivable and the upload attributable before any bytes move.
 */

const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export type StorageConfig = {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  ttlSeconds: number;
  maxUploadBytes: number;
};

/**
 * Named `S3_*` rather than `AWS_*` on purpose: the Lambda runtime Vercel
 * deploys into populates its own `AWS_*` variables, and a collision there would
 * be silent.
 */
export function storageConfig(): StorageConfig | null {
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!bucket || !region || !accessKeyId || !secretAccessKey) return null;

  return {
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    endpoint: process.env.S3_ENDPOINT || undefined,
    ttlSeconds: positiveInt(process.env.S3_SIGNED_URL_TTL_SECONDS, DEFAULT_TTL_SECONDS),
    maxUploadBytes: positiveInt(process.env.S3_MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * The reason uploads are unavailable, in the words the workspace should show.
 *
 * A missing bucket is a configuration state, not a crash: the screen says the
 * dependency is outstanding — the same shape every other unmet dependency in
 * this product takes — rather than throwing on render.
 */
export const STORAGE_NOT_CONFIGURED =
  'Asset storage is not configured on this deployment. S3_BUCKET, S3_REGION, ' +
  'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY have to be set before work can be uploaded.';

export class StorageNotConfiguredError extends Error {
  constructor() {
    super(STORAGE_NOT_CONFIGURED);
    this.name = 'StorageNotConfiguredError';
  }
}

let client: S3Client | null = null;
let clientKey = '';

function s3(config: StorageConfig): S3Client {
  const key = `${config.region}|${config.endpoint ?? ''}|${config.accessKeyId}`;
  if (!client || clientKey !== key) {
    client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      // MinIO and the like do not do virtual-hosted-style addressing.
      forcePathStyle: Boolean(config.endpoint),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    clientKey = key;
  }
  return client;
}

export function requireStorage(): StorageConfig {
  const config = storageConfig();
  if (!config) throw new StorageNotConfiguredError();
  return config;
}

/**
 * The last check before a signature.
 *
 * The key always came from a row read inside the tenant's RLS context, so this
 * should be impossible. It is here because "should be impossible" is what every
 * cross-tenant leak was before it happened, and because the cost of the second
 * check is one string comparison.
 */
function assertTenantKey(key: string, tenantId: string): void {
  if (!isTenantScopedKey(key, tenantId)) {
    throw new Error(`Refusing to sign "${key}": it is not under tenant/${tenantId}/.`);
  }
}

/** A short-lived PUT the browser uploads to directly. */
export async function signedUploadUrl(input: {
  tenantId: string;
  key: string;
  contentType: string;
  sizeBytes: number;
}): Promise<{ url: string; expiresInSeconds: number }> {
  const config = requireStorage();
  assertTenantKey(input.key, input.tenantId);
  if (input.sizeBytes > config.maxUploadBytes) {
    throw new Error(
      `That file is ${Math.round(input.sizeBytes / 1024 / 1024)} MB; the limit is ` +
        `${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.`,
    );
  }

  const url = await getSignedUrl(
    s3(config),
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: input.key,
      ContentType: input.contentType,
    }),
    { expiresIn: config.ttlSeconds },
  );
  return { url, expiresInSeconds: config.ttlSeconds };
}

/**
 * A short-lived GET, handed out one request at a time.
 *
 * `ResponseContentDisposition` carries the original file name, so the client
 * saves `Q3-report.pdf` rather than a uuid — the key stays opaque and the
 * download stays recognisable.
 */
export async function signedDownloadUrl(input: {
  tenantId: string;
  key: string;
  fileName: string | null;
  mimeType: string | null;
  disposition?: 'inline' | 'attachment';
}): Promise<string> {
  const config = requireStorage();
  assertTenantKey(input.key, input.tenantId);

  const name = (input.fileName ?? 'download').replace(/"/g, '');
  return getSignedUrl(
    s3(config),
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: input.key,
      ResponseContentDisposition: `${input.disposition ?? 'attachment'}; filename="${name}"`,
      ...(input.mimeType ? { ResponseContentType: input.mimeType } : {}),
    }),
    { expiresIn: config.ttlSeconds },
  );
}

/**
 * Whether the bytes actually arrived, and how many.
 *
 * The browser PUTs straight to S3, so the only honest way to know an upload
 * completed is to ask S3 — a client that reports success is reporting what it
 * hopes happened. An asset whose object is missing never leaves `draft`, so it
 * can never reach a delivered count.
 */
export async function headObject(input: {
  tenantId: string;
  key: string;
}): Promise<{ sizeBytes: number; mimeType: string | null } | null> {
  const config = requireStorage();
  assertTenantKey(input.key, input.tenantId);

  try {
    const head = await s3(config).send(
      new HeadObjectCommand({ Bucket: config.bucket, Key: input.key }),
    );
    return {
      sizeBytes: Number(head.ContentLength ?? 0),
      mimeType: head.ContentType ?? null,
    };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || status === 403) return null;
    throw error;
  }
}
