'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Send, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * The client's decision on one asset, and Zeeraa's submit for the drafts.
 *
 * Sending work back requires a reason, in the component and in the endpoint:
 * "changes requested" with no reason is a rejection the client cannot act on
 * and Zeeraa cannot answer.
 *
 * Neither button is the access control. Approving is gated by a trigger on
 * `assets` that reads the caller's membership, so a client viewer who finds the
 * endpoint gets a database error rather than a delivered figure.
 */
export function ReviewActions({
  slug,
  assetId,
  canDecide,
  canSubmit,
  status,
  superseded,
}: {
  slug: string;
  assetId: string;
  canDecide: boolean;
  canSubmit: boolean;
  status: string;
  /** A later version has taken this one's place. */
  superseded: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');

  // A superseded version is history. Deciding on it would change nothing —
  // it counts toward no delivered figure either way — so it carries the record
  // and no buttons.
  const decidable = !superseded && (status === 'submitted' || status === 'in_review');
  const showDecide = canDecide && decidable;
  const showApproveAfterChanges = canDecide && !superseded && status === 'changes_requested';
  const showSubmit = canSubmit && !superseded && status === 'draft';

  if (!showDecide && !showSubmit && !showApproveAfterChanges) return null;

  async function act(action: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/assets/${slug}/${assetId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...body }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
      setAsking(false);
      setReason('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
      {asking ? (
        <div className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-semibold text-text-2">What needs changing</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="w-full rounded-[8px] border border-border bg-surface px-2 py-1.5 text-[12px] text-text outline-none focus:border-primary"
            />
          </label>
          <div className="flex gap-1.5">
            <Button
              variant="primary"
              disabled={busy || reason.trim().length === 0}
              onClick={() => act('request_changes', { reason })}
              className="h-8"
            >
              Send back
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setAsking(false)} className="h-8">
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {showSubmit && (
            <Button variant="primary" disabled={busy} onClick={() => act('submit')} className="h-8">
              <Send aria-hidden="true" className="h-3.5 w-3.5" />
              Submit for approval
            </Button>
          )}
          {(showDecide || showApproveAfterChanges) && (
            <Button variant="primary" disabled={busy} onClick={() => act('approve')} className="h-8">
              <Check aria-hidden="true" className="h-3.5 w-3.5" />
              Approve
            </Button>
          )}
          {showDecide && (
            <Button variant="secondary" disabled={busy} onClick={() => setAsking(true)} className="h-8">
              <Undo2 aria-hidden="true" className="h-3.5 w-3.5" />
              Request changes
            </Button>
          )}
        </div>
      )}
      {error && (
        <p aria-live="polite" className="text-[12px] text-down-text">
          {error}
        </p>
      )}
    </div>
  );
}
