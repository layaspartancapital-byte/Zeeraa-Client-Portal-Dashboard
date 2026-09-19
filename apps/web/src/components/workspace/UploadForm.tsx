'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Upload } from 'lucide-react';
import type { WorkspaceCommitmentOption } from '@/lib/dashboard';
import { Button } from '@/components/ui/Button';

/**
 * Putting work into the workspace, tagged to the commitment it satisfies.
 *
 * Three steps, in this order and for a reason: the row is created first so the
 * object key can be derived from it, the file then goes from the browser
 * straight to S3 against a signed PUT — never through a serverless function
 * with a 4.5 MB body limit — and only then is the asset submitted, which is
 * what asks the client for a decision.
 *
 * The commitment and the period are required rather than optional. An asset
 * tagged to neither is a file in a folder; the whole point of this screen is
 * that an approval moves a number on the delivery view.
 */
export function UploadForm({
  slug,
  types,
  commitments,
  /** Tenant-local today, so the period defaults to the month being worked in. */
  today,
  replaceable,
  disabledReason,
}: {
  slug: string;
  types: { key: string; label: string }[];
  commitments: WorkspaceCommitmentOption[];
  today: string;
  /** Assets the client sent back, which a new upload may replace. */
  replaceable: { id: string; title: string; commitmentKey: string | null; version: number }[];
  disabledReason?: string | null;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);

  const [type, setType] = useState(types[0]?.key ?? '');
  const [commitmentKey, setCommitmentKey] = useState(commitments[0]?.key ?? '');
  const [title, setTitle] = useState('');
  const [periodDay, setPeriodDay] = useState(today.slice(0, 7));
  const [externalUrl, setExternalUrl] = useState('');
  const [supersedes, setSupersedes] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const months = useMemo(() => lastMonths(today, 12), [today]);
  const commitment = commitments.find((c) => c.key === commitmentKey);
  // Only work sent back under the same commitment: a version chain that crossed
  // commitments would move a delivered count from one row to another.
  const replacements = replaceable.filter((a) => a.commitmentKey === commitmentKey);

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setDone(null);

    const file = fileInput.current?.files?.[0] ?? null;
    if (!file && !externalUrl.trim()) {
      setError('Attach a file, or give the URL where the work went live.');
      return;
    }

    try {
      setBusy('Creating the record');
      const created = await post(`/api/assets/${slug}`, {
        type,
        title,
        commitmentKey,
        periodDay: `${periodDay}-01`,
        externalUrl: externalUrl.trim() || null,
        supersedesAssetId: supersedes || null,
        file: file
          ? { name: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size }
          : null,
      });

      if (file && created.uploadUrl) {
        setBusy('Uploading');
        const put = await fetch(created.uploadUrl as string, {
          method: 'PUT',
          body: file,
          headers: { 'content-type': file.type || 'application/octet-stream' },
        });
        // A failure here is almost always the bucket's CORS rule rather than
        // the file, and saying so saves an afternoon.
        if (!put.ok) {
          throw new Error(
            `The bucket refused the upload (${put.status}). Check the CORS rule allows PUT from this origin.`,
          );
        }
      }

      setBusy('Submitting for approval');
      await post(`/api/assets/${slug}/${created.assetId as string}`, { action: 'submit' });

      setTitle('');
      setExternalUrl('');
      setSupersedes('');
      if (fileInput.current) fileInput.current.value = '';
      setDone('Submitted for the client to review.');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  if (disabledReason) {
    return (
      <div className="flex min-h-[112px] flex-col items-center justify-center gap-2 rounded-[8px] border border-dashed border-border bg-canvas px-4 py-6 text-center">
        <Upload aria-hidden="true" className="h-5 w-5 text-text-3" />
        <p className="text-[13px] text-text-3">{disabledReason}</p>
      </div>
    );
  }

  return (
    <form onSubmit={upload} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Title">
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="September creative set, variant B"
            className={INPUT}
          />
        </Field>

        <Field label="Asset type">
          <select value={type} onChange={(e) => setType(e.target.value)} className={INPUT}>
            {types.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Commitment">
          <select
            value={commitmentKey}
            onChange={(e) => setCommitmentKey(e.target.value)}
            className={INPUT}
          >
            {commitments.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label={commitment?.period === 'quarterly' ? 'Period (quarter)' : 'Period (month)'}
        >
          <select
            value={periodDay}
            onChange={(e) => setPeriodDay(e.target.value)}
            className={INPUT}
          >
            {months.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="File">
          <input ref={fileInput} type="file" className={`${INPUT} py-1.5`} />
        </Field>

        <Field label="Or the URL it went live at">
          <input
            type="url"
            value={externalUrl}
            onChange={(e) => setExternalUrl(e.target.value)}
            placeholder="https://"
            className={INPUT}
          />
        </Field>

        {replacements.length > 0 && (
          <Field label="Replaces">
            <select
              value={supersedes}
              onChange={(e) => setSupersedes(e.target.value)}
              className={INPUT}
            >
              <option value="">Nothing — this is new work</option>
              {replacements.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title} (v{a.version})
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={busy !== null}>
          <Upload aria-hidden="true" className="h-4 w-4" />
          {busy ?? 'Upload and submit'}
        </Button>
        <span aria-live="polite" className="min-w-0 text-[12px]">
          {error && <span className="text-down-text">{error}</span>}
          {done && !error && <span className="text-text-2">{done}</span>}
        </span>
      </div>
    </form>
  );
}

const INPUT =
  'h-9 w-full rounded-[8px] border border-border bg-surface px-2.5 text-[13px] text-text ' +
  'outline-none transition-colors focus:border-primary';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[12px] font-semibold text-text-2">{label}</span>
      {children}
    </label>
  );
}

async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(payload.error ?? `Request failed (${response.status}).`));
  return payload;
}

/** The current month first, then back. Quarterly commitments fold to a quarter server-side. */
function lastMonths(today: string, count: number): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  let year = Number(today.slice(0, 4));
  let month = Number(today.slice(5, 7));
  for (let i = 0; i < count; i += 1) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    out.push({
      key,
      label: new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }),
    });
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return out;
}
