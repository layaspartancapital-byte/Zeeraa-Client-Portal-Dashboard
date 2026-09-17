import type { ReactNode } from 'react';

/**
 * A panel is a hairline rule and some space — never a rounded card with a soft
 * grey shadow. Cards of that kind flatten hierarchy, which is the one thing
 * this application cannot afford: the executive view has to say clearly that
 * one number matters more than the four beneath it.
 */
export function Panel({
  title,
  description,
  aside,
  children,
  className = '',
}: {
  title?: string;
  description?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || aside) && (
        <div className="panel-header">
          <div className="min-w-0">
            {title && <h2 className="text-[13px] font-medium text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-[12px] text-graphite">{description}</p>}
          </div>
          {aside && <div className="shrink-0 text-[11px] text-graphite">{aside}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * An empty state says what would fill this space and what is missing. It never
 * renders a blank plot area or a zero that looks like a measurement.
 *
 * The `blocked` variant is for a dependency outside Zeeraa's control — a
 * Salesforce field that does not exist, click-ID capture not yet live. It is a
 * designed state, not an error: a visible dependency is a conversation, a
 * silent gap looks like the agency failed.
 */
export function EmptyState({
  heading,
  body,
  needed,
  since,
  variant = 'empty',
}: {
  heading: string;
  body: string;
  needed?: string;
  since?: string;
  variant?: 'empty' | 'blocked';
}) {
  return (
    <div className="px-5 py-8">
      <div
        className={`max-w-prose border-l-2 pl-4 ${
          variant === 'blocked' ? 'border-graphite' : 'border-rule'
        }`}
      >
        <p className="text-[13px] text-ink">{heading}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-graphite">{body}</p>
        {needed && (
          <p className="mt-2 text-[12px] leading-relaxed text-graphite">
            <span className="text-ink">Needed:</span> {needed}
            {since && <span className="text-provisional"> · outstanding since {since}</span>}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Loading shows the shape of what is coming — skeleton rows matching the real
 * table — rather than a spinner on an empty page.
 */
export function SkeletonRows({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div aria-hidden="true" className="divide-y divide-rule">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 px-5 py-3">
          {Array.from({ length: columns }).map((_, c) => (
            <div
              key={c}
              className="h-3 rounded-[2px] bg-rule/70"
              style={{ width: c === 0 ? '28%' : '12%' }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
