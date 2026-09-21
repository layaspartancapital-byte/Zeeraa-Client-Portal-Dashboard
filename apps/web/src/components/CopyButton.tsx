'use client';

import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * Copies a value and says so.
 *
 * The password is also `select-all`, so this is the quick path rather than the
 * only one — `navigator.clipboard` needs a secure context and permission, and
 * on a deployment behind a plain-http tunnel it is simply absent. When it is
 * unavailable or refuses, the button says so instead of silently doing nothing,
 * because an admin who believes they copied a password and did not will paste
 * the wrong thing to somebody waiting on it.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2500);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          if (!navigator.clipboard) throw new Error('no clipboard');
          await navigator.clipboard.writeText(value);
          setState('copied');
        } catch {
          setState('failed');
        }
      }}
      aria-label={label}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] border border-border bg-surface px-2.5 text-[12px] font-medium text-text-2 transition-colors hover:bg-canvas hover:text-text"
    >
      {state === 'copied' ? (
        <Check aria-hidden="true" className="h-3.5 w-3.5" />
      ) : (
        <Copy aria-hidden="true" className="h-3.5 w-3.5" />
      )}
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it instead' : 'Copy'}
    </button>
  );
}
