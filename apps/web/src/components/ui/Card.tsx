import type { ReactNode } from 'react';

/**
 * The one container in the system.
 *
 * White surface, 12px radius, the two-layer shadow from spec v2 §3. A card is
 * never a hairline rule with whitespace, and the only thing that varies is
 * padding and whether it lifts on hover — which it does only when the whole
 * card is interactive.
 */
export function Card({
  children,
  className = '',
  span,
  interactive = false,
  selfStart = false,
  as: Tag = 'section',
  id,
  dataTour,
}: {
  children: ReactNode;
  className?: string;
  /** Columns of the 12-column grid. */
  span?: 3 | 4 | 6 | 8 | 12;
  interactive?: boolean;
  /**
   * Keep the card at its natural height instead of stretching to the tallest
   * card in its row. For the card that sits beside the data-quality list: a
   * two-row table stretched to match nine outstanding dependencies is mostly
   * empty surface.
   */
  selfStart?: boolean;
  as?: 'section' | 'div' | 'li' | 'article';
  /** For an anchor target, so a redirect can bring a card into view. */
  id?: string;
  /** Where the product tour spotlights this card (`ProductTour`). */
  dataTour?: string;
}) {
  return (
    <Tag
      id={id}
      data-tour={dataTour}
      className={`card print-full flex min-w-0 flex-col ${
        interactive ? 'card-lift' : ''
      } ${selfStart ? 'self-start' : ''} ${span ? SPAN[span] : ''} ${className}`}
    >
      {children}
    </Tag>
  );
}

/**
 * Column spans, written out rather than interpolated: Tailwind's scanner reads
 * source text, and `col-span-${n}` produces no class at all.
 */
const SPAN: Record<number, string> = {
  3: 'col-span-12 sm:col-span-6 xl:col-span-3',
  4: 'col-span-12 lg:col-span-4',
  6: 'col-span-12 lg:col-span-6',
  8: 'col-span-12 lg:col-span-8',
  12: 'col-span-12',
};

/**
 * Card header: title, optional subtitle, right-aligned controls. The controls
 * slot is where a period toggle, an ⓘ or a ⋯ menu goes — never a paragraph.
 */
export function CardHeader({
  title,
  subtitle,
  controls,
  info,
  className = '',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  controls?: ReactNode;
  info?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-4 pb-3 ${className}`}
    >
      <div className="min-w-0">
        <h2 className="flex items-center gap-1.5 text-[15px] font-semibold text-text">
          {title}
          {info}
        </h2>
        {subtitle && <p className="mt-0.5 text-[13px] text-text-2">{subtitle}</p>}
      </div>
      {controls && <div className="flex shrink-0 items-center gap-2 print-hidden">{controls}</div>}
    </div>
  );
}

export function CardBody({
  children,
  className = '',
  flush = false,
}: {
  children: ReactNode;
  className?: string;
  /** No horizontal padding — for a table that runs to the card edge. */
  flush?: boolean;
}) {
  return <div className={`${flush ? 'pb-1' : 'px-5 pb-5'} ${className}`}>{children}</div>;
}

/**
 * An empty state is one line plus at most one action, in muted text, inside the
 * card. Never a boxed paragraph, never a zero standing in for a measurement.
 */
export function EmptyLine({
  children,
  action,
  href,
  className = '',
}: {
  children: ReactNode;
  /** One action, at most. A second one means the state is not empty. */
  action?: ReactNode;
  /** Shorthand: renders `action` as a link to here. */
  href?: string;
  className?: string;
}) {
  return (
    <p
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-text-3 ${className}`}
    >
      <span>{children}</span>
      {href ? (
        <a className="link" href={href}>
          {action}
        </a>
      ) : (
        action
      )}
    </p>
  );
}

/** The 12-column content grid, 24px gutters. */
export function Grid({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`grid grid-cols-12 gap-6 ${className}`}>{children}</div>;
}
