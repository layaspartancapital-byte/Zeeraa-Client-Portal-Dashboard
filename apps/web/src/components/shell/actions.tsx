'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Printer, RefreshCw } from 'lucide-react';
import { Button, IconButton } from '@/components/ui/Button';

/** Print for a quarterly review. The stylesheet does the rest. */
export function PrintButton() {
  return (
    <IconButton label="Print this view" onClick={() => window.print()}>
      <Printer aria-hidden="true" className="h-4 w-4" />
    </IconButton>
  );
}

type Outcome = {
  tenantId: string;
  platform: string;
  status: 'succeeded' | 'partial' | 'skipped' | 'failed';
  detail: string;
  remedy?: string;
  durationMs: number;
};

type SyncResponse = {
  ok?: boolean;
  error?: string;
  durationMs?: number;
  outcomes?: Outcome[];
};

const TONE: Record<Outcome['status'], string> = {
  succeeded: 'text-up-text',
  partial: 'text-[#B54708]',
  skipped: 'text-text-2',
  failed: 'text-down-text',
};

/**
 * "Sync now", for `zeeraa_admin`.
 *
 * Runs the same incremental sync the hourly cron runs — two days of paid media
 * and Salesforce since its last completed read — and waits for it, so what the
 * button reports is what happened rather than that something was queued.
 *
 * Every outcome is shown, including `skipped`, which is not a failure: it is
 * what the endpoint says when the honest incremental window does not exist and
 * the backfill script is the right tool. A `remedy` names the next action
 * rather than leaving it to be inferred.
 */
export function SyncNowButton({
  slug,
  platform,
  label = 'Sync now',
}: {
  slug: string;
  /** Scope to one connector. Omitted, every connected platform runs. */
  platform?: string;
  label?: string;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SyncResponse | null>(null);
  const router = useRouter();

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      const query = platform ? `?platform=${encodeURIComponent(platform)}` : '';
      const response = await fetch(`/api/sync/${slug}${query}`, { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as SyncResponse;
      setResult(body);
      // Figures on the page came from before the sync; re-read them.
      if (body.outcomes?.some((o) => o.status === 'succeeded' || o.status === 'partial')) {
        router.refresh();
      }
    } catch (error) {
      setResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setRunning(false);
    }
  }

  const seconds = result?.durationMs ? (result.durationMs / 1000).toFixed(1) : null;

  return (
    <span className="inline-flex min-w-0 flex-col items-start gap-1">
      <Button variant="secondary" onClick={run} disabled={running}>
        <RefreshCw
          aria-hidden="true"
          className={`h-4 w-4 ${running ? 'animate-spin' : ''}`}
        />
        {running ? 'Syncing…' : label}
      </Button>

      <span aria-live="polite" className="min-w-0">
        {result?.error && (
          <span className="block max-w-[22rem] text-[12px] text-down-text">{result.error}</span>
        )}
        {result?.outcomes?.map((outcome) => (
          <span key={outcome.platform + outcome.tenantId} className="block max-w-[22rem]">
            <span className={`text-[12px] font-semibold ${TONE[outcome.status]}`}>
              {outcome.status}
            </span>
            <span className="text-[12px] text-text-2"> · {outcome.detail}</span>
            {outcome.remedy && (
              <span className="block text-[12px] text-text-3">{outcome.remedy}</span>
            )}
          </span>
        ))}
        {seconds && result?.outcomes?.length ? (
          <span className="block text-[12px] tabular text-text-3">completed in {seconds}s</span>
        ) : null}
      </span>
    </span>
  );
}
