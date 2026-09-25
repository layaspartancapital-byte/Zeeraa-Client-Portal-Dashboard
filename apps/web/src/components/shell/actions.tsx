'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  MinusCircle,
  Printer,
  RefreshCw,
  X,
  XCircle,
} from 'lucide-react';
import { Button, IconButton } from '@/components/ui/Button';
import { platformLabel } from '@/lib/platform-labels';

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
  /** Refused by the per-tenant throttle: `error` is the wait, not a fault. */
  throttled?: boolean;
  durationMs?: number;
  outcomes?: Outcome[];
};

/**
 * How each outcome reads. Never colour alone: every status has its own icon
 * and its own word, and a failure is also a bordered, tinted row.
 *
 * Deliberately not green and red. Those mean a metric improved or regressed
 * and nothing else in this product; a sync that worked is not an improvement.
 * A failure takes the amber this product already uses for "needs a person".
 */
const STATUS: Record<
  Outcome['status'],
  { word: string; icon: typeof CheckCircle2; row: string; iconClass: string }
> = {
  succeeded: { word: 'Synced', icon: CheckCircle2, row: '', iconClass: 'text-text-2' },
  partial: {
    word: 'Partly synced',
    icon: AlertTriangle,
    row: 'rounded-[8px] border border-[#FEDF89] bg-warn-soft',
    iconClass: 'text-[#B54708]',
  },
  skipped: { word: 'Skipped', icon: MinusCircle, row: '', iconClass: 'text-text-3' },
  failed: {
    word: 'Failed',
    icon: XCircle,
    row: 'rounded-[8px] border border-[#FEDF89] bg-warn-soft',
    iconClass: 'text-[#B54708]',
  },
};

/**
 * "Sync now", for every member of the tenant (`canSyncNow`).
 *
 * At most one manual sync per tenant every five minutes; a press inside that
 * says "Synced 2 min ago, next available in 3 min" and is not a failure.
 *
 * Runs the same incremental sync the hourly cron runs — two days of paid media
 * and Salesforce since its last completed read — and waits for it, so what the
 * button reports is what happened rather than that something was queued.
 *
 * **The result is a toast, not a line under the button.** Inline, it pushed the
 * whole control row down and named no connector, so "succeeded · 2 days" sat
 * under a button that had just run three of them. The toast is fixed to the
 * viewport and portalled to `<body>`, so nothing on the page moves; every line
 * names its connector; and it stays until dismissed when anything failed,
 * because a failure that disappears on a timer is a failure nobody read.
 *
 * Every outcome is shown, including `skipped`, which is not a failure: it is
 * what the endpoint says when the honest incremental window does not exist and
 * the backfill script is the right tool. A `remedy` names the next action.
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
  const [mounted, setMounted] = useState(false);
  const router = useRouter();

  useEffect(() => setMounted(true), []);

  const throttled = Boolean(result?.throttled);
  const failed =
    !throttled &&
    (Boolean(result?.error) || Boolean(result?.outcomes?.some((o) => o.status === 'failed')));

  // A clean run clears itself; anything that failed waits for the reader.
  useEffect(() => {
    if (!result || failed) return;
    const timer = window.setTimeout(() => setResult(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [result, failed]);

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      const query = platform ? `?platform=${encodeURIComponent(platform)}` : '';
      const response = await fetch(`/api/sync/${slug}${query}`, { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as SyncResponse;
      setResult(
        response.ok || body.outcomes
          ? body
          : { ok: false, error: body.error ?? `The sync endpoint answered ${response.status}.` },
      );
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
  const outcomes = result?.outcomes ?? [];
  const failures = outcomes.filter((o) => o.status === 'failed').length;
  const heading = throttled
    ? (result?.error ?? 'Sync not available yet')
    : result?.error
    ? 'Sync did not run'
    : failures > 0
      ? `Sync finished · ${failures} of ${outcomes.length} failed`
      : 'Sync finished';

  return (
    <>
      <Button variant="secondary" onClick={run} disabled={running}>
        <RefreshCw aria-hidden="true" className={`h-4 w-4 ${running ? 'animate-spin' : ''}`} />
        {running ? 'Syncing…' : label}
      </Button>

      {mounted &&
        createPortal(
          <div
            role={failed ? 'alert' : 'status'}
            aria-live={failed ? 'assertive' : 'polite'}
            className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex justify-end sm:left-auto sm:right-6"
          >
            {result && (
              <div className="pointer-events-auto w-full max-w-[24rem] rounded-[12px] border border-border bg-surface p-3 shadow-[var(--shadow-pop)] print-hidden">
                <div className="flex items-start gap-2">
                  <p className="min-w-0 flex-1 text-[13px] font-semibold text-text">{heading}</p>
                  {seconds && outcomes.length > 0 && (
                    <span className="shrink-0 text-[12px] tabular text-text-3">{seconds}s</span>
                  )}
                  <button
                    type="button"
                    onClick={() => setResult(null)}
                    aria-label="Dismiss sync results"
                    className="-mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-text-3 hover:bg-canvas hover:text-text"
                  >
                    <X aria-hidden="true" className="h-4 w-4" />
                  </button>
                </div>

                {result.error && !throttled && (
                  <p className="mt-2 flex gap-2 rounded-[8px] border border-[#FEDF89] bg-warn-soft px-2.5 py-2 text-[13px] text-text">
                    <XCircle aria-hidden="true" className="mt-[1px] h-4 w-4 shrink-0 text-[#B54708]" />
                    <span className="min-w-0">
                      <span className="font-semibold">Failed.</span> {result.error}
                    </span>
                  </p>
                )}

                {outcomes.length > 0 && (
                  <ul className="mt-2 space-y-1.5">
                    {outcomes.map((outcome) => {
                      const look = STATUS[outcome.status];
                      const Icon = look.icon;
                      return (
                        <li
                          key={outcome.platform + outcome.tenantId}
                          className={`flex gap-2 px-2.5 py-1.5 ${look.row}`}
                        >
                          <Icon aria-hidden="true" className={`mt-[2px] h-4 w-4 shrink-0 ${look.iconClass}`} />
                          <span className="min-w-0 text-[13px] leading-snug">
                            <span className="font-semibold text-text">
                              {platformLabel(outcome.platform)}
                            </span>
                            <span className={outcome.status === 'failed' ? 'font-semibold text-text' : 'text-text-2'}>
                              {' '}
                              · {look.word}
                            </span>
                            <span className="block break-words text-[12px] text-text-2">
                              {outcome.detail}
                            </span>
                            {outcome.remedy && (
                              <span className="block text-[12px] text-text-3">{outcome.remedy}</span>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
