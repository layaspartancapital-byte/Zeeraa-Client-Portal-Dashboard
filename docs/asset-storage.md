# Asset storage

Workspace uploads are a client's unreleased creatives, draft landing pages and
reports. They live in one private S3 bucket and are never served from it
directly.

The guarantee: **no object is public, and no URL to one is handed out that was
not signed for a caller whose access was checked first.** Four things carry it
and none is sufficient alone.

1. The bucket blocks all public access and ACLs are disabled, so an object
   cannot be made readable by getting a header wrong.
2. Keys are `tenant/{tenant_id}/…`, and the credentials the application holds
   reach `…/tenant/*` and nothing else.
3. `assertTenantKey` in `apps/web/src/lib/storage.ts` refuses a key belonging to
   another tenant before a signature exists. The row that key came from was read
   through row level security, so this is the second of two checks.
4. Signed URLs last minutes and are produced per request. Nothing is stored on a
   row, embedded in a page or cached — `/api/assets/{tenant}/{id}/file` answers
   `Cache-Control: no-store, private`.

## Bucket

One bucket, in the region the app runs in.

| Setting | Value |
| --- | --- |
| Block Public Access | all four ON |
| Object Ownership | Bucket owner enforced (ACLs disabled) |
| Default encryption | SSE-S3 (`AES256`), or SSE-KMS |
| Versioning | Enabled — old asset versions are never deleted |
| Lifecycle rule | Abort incomplete multipart uploads after 7 days |

Bucket policy, refusing anything not over TLS:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DenyInsecureTransport",
    "Effect": "Deny",
    "Principal": "*",
    "Action": "s3:*",
    "Resource": [
      "arn:aws:s3:::BUCKET",
      "arn:aws:s3:::BUCKET/*"
    ],
    "Condition": { "Bool": { "aws:SecureTransport": "false" } }
  }]
}
```

CORS. The browser PUTs the file straight to S3 against a presigned URL, because
a serverless request body is capped well below a webinar recording:

```json
[{
  "AllowedOrigins": ["https://portal.zeeraa.com", "http://localhost:3000"],
  "AllowedMethods": ["PUT"],
  "AllowedHeaders": ["content-type"],
  "ExposeHeaders": ["etag"],
  "MaxAgeSeconds": 3000
}]
```

A missing or wrong CORS rule is the single most likely reason an upload fails,
and it fails in the browser rather than on the server — so `UploadForm` names it
in the error rather than reporting a bare status code.

## IAM

One user, its access key in the environment. Inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "TenantScopedObjects",
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload"],
    "Resource": "arn:aws:s3:::BUCKET/tenant/*"
  }]
}
```

Three omissions, each deliberate:

- **No `s3:ListBucket`.** The application only ever addresses a key it already
  holds on a row it read through RLS. Without List, a leaked credential cannot
  enumerate what other tenants hold.
- **No `s3:DeleteObject`.** Superseded versions stay; the approval chain has to
  remain reviewable.
- **`/tenant/*` only.** A key built outside that prefix fails at the storage
  layer rather than writing one client's artwork somewhere another client's
  signed URL could reach.

## Environment

```bash
S3_BUCKET=
S3_REGION=us-east-2
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=

# Optional; defaults are 300 seconds and 100 MB.
S3_SIGNED_URL_TTL_SECONDS=300
S3_MAX_UPLOAD_BYTES=104857600
# Local MinIO only. Unset against real S3.
S3_ENDPOINT=
```

Named `S3_*` rather than `AWS_*` because the Lambda runtime Vercel deploys into
populates its own `AWS_*` variables, and a collision there would be silent.

With none of the four required variables set the workspace does not crash: it
renders `Storage not configured` on the upload card and the endpoints answer
503 with the missing variables named. An unconfigured dependency is a state this
product renders, not an error it hides.

## Locally, without AWS

MinIO is enough to exercise the whole signed-URL path:

```bash
docker run -d --name zeeraa-minio -p 9100:9000 -p 9101:9001 \
  -e MINIO_ROOT_USER=zeeraatest -e MINIO_ROOT_PASSWORD=zeeraatest123 \
  quay.io/minio/minio:latest server /data --console-address ":9001"

docker run --rm --network host --entrypoint sh quay.io/minio/mc:latest -c \
  "mc alias set local http://localhost:9100 zeeraatest zeeraatest123 && \
   mc mb --ignore-existing local/zeeraa-client-assets"
```

Then in `apps/web/.env.local`: `S3_BUCKET=zeeraa-client-assets`,
`S3_REGION=us-east-1`, the two keys above, and
`S3_ENDPOINT=http://localhost:9100`. `forcePathStyle` switches on whenever
`S3_ENDPOINT` is set, which is what MinIO needs and what real S3 does not want.
