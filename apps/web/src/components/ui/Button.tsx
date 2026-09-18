import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Buttons (spec v2 §6). Primary is a blue fill, secondary is a white surface
 * with the border token, both 36px tall on an 8px radius.
 *
 * Rendered as a link where the action is a navigation — an export, a print
 * view, a filter — because those must survive being opened in a new tab.
 */
const BASE =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-[8px] px-3 text-[13px] font-semibold whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50';

const VARIANTS = {
  primary: 'bg-primary text-white hover:bg-primary-600',
  secondary: 'border border-border bg-surface text-text hover:bg-canvas',
  ghost: 'text-text-2 hover:bg-canvas hover:text-text',
} as const;

export type ButtonVariant = keyof typeof VARIANTS;

export function Button({
  children,
  variant = 'secondary',
  type = 'button',
  className = '',
  ...rest
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={`${BASE} ${VARIANTS[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function ButtonLink({
  children,
  href,
  variant = 'secondary',
  className = '',
  ...rest
}: {
  children: ReactNode;
  href: string;
  variant?: ButtonVariant;
  className?: string;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return (
    <Link href={href} className={`${BASE} ${VARIANTS[variant]} ${className}`} {...rest}>
      {children}
    </Link>
  );
}

/** 36×36, for an icon with no room for a label. Always carries an aria-label. */
export function IconButton({
  children,
  label,
  className = '',
  ...rest
}: {
  children: ReactNode;
  label: string;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-border bg-surface text-text-2 transition-colors hover:bg-canvas hover:text-text ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
