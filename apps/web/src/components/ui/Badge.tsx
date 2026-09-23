import type { ReactNode } from 'react';

/**
 * Status pills (spec v2 §6).
 *
 * The tones are a closed set, and each one means one thing. `warn` is blocked,
 * not measured or provisional; `up` and `down` are improvement and regression
 * as the metric defines them and are never borrowed for anything else; `neutral`
 * is a dependency on somebody, which is a fact rather than a fault.
 *
 * Every badge carries a word. Colour is never the only encoding, because the
 * client prints this and some of them are colourblind.
 */
export type BadgeTone = 'warn' | 'up' | 'down' | 'neutral' | 'primary';

const TONES: Record<BadgeTone, string> = {
  warn: 'bg-warn-soft text-[#B54708] border-[#FEDF89]',
  up: 'bg-up-soft text-[#027A48] border-[#A6F4C5]',
  down: 'bg-down-soft text-[#B42318] border-[#FECDCA]',
  neutral: 'bg-canvas text-text-2 border-border',
  primary: 'bg-primary-100 text-primary border-primary-soft',
};

export function Badge({
  tone = 'neutral',
  children,
  className = '',
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  /** The full text, where the caller lets a long label truncate. */
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-[2px] text-[12px] font-semibold leading-[18px] ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * The two states the whole product turns on, named once so they cannot drift
 * into "0" or "—" at some call site.
 */
export function NotMeasuredBadge({ className = '' }: { className?: string }) {
  return (
    <Badge tone="warn" className={className}>
      Not measured
    </Badge>
  );
}

export function ProvisionalBadge({ className = '' }: { className?: string }) {
  return (
    <Badge tone="warn" className={className}>
      Provisional
    </Badge>
  );
}
