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

/**
 * "Sync now", for `zeeraa_admin`.
 *
 * Reports what actually happened rather than flashing a success state: the
 * event either reached the queue or it did not, and until this deployment is
 * registered with Inngest it does not. An error explains the next action.
 */
export function SyncNowButton({
  slug,
  platform,
  label = 'Sync now',
}: {
  slug: string;
  platform: string;
  label?: string;
}) {
  const [state, setState] = useState<'idle' | 'running' | 'queued' | 'failed'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();

  async function run() {
    setState('running');
    setMessage(null);
    try {
      const response = await fetch(
        `/api/sync/${slug}?platform=${encodeURIComponent(platform)}`,
        { method: 'POST' },
      );
      const body = (await response.json()) as { ok: boolean; error?: string };
      if (body.ok) {
        setState('queued');
        router.refresh();
      } else {
        setState('failed');
        setMessage(body.error ?? 'The sync queue refused the request.');
      }
    } catch (error) {
      setState('failed');
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant="secondary"
        onClick={run}
        disabled={state === 'running'}
        aria-live="polite"
      >
        <RefreshCw
          aria-hidden="true"
          className={`h-4 w-4 ${state === 'running' ? 'animate-spin' : ''}`}
        />
        {state === 'queued' ? 'Queued' : state === 'running' ? 'Syncing…' : label}
      </Button>
      {message && <span className="max-w-[22rem] text-[12px] text-down">{message}</span>}
    </span>
  );
}
