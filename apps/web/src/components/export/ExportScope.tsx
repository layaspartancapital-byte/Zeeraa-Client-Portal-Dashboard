'use client';

import { createContext, useContext } from 'react';
import { FileSpreadsheet } from 'lucide-react';

/**
 * What every Excel export on a page follows (30 October 2026): the tenant,
 * the page, its resolved range, attribution model and source. Set once per
 * page, so a card's button cannot export a different period from the one on
 * screen — and outside a scope a button renders nothing.
 *
 * The URL carries these filters and the export's name, never anything
 * personal; contact columns are decided on the server by the viewer's role.
 */
export type ExportScopeValue = {
  slug: string;
  page: 'executive' | 'performance' | 'funnel' | 'platform';
  from: string;
  to: string;
  model?: string;
  source?: string | null;
  /** A platform page's platform. */
  platform?: string | null;
};

const Scope = createContext<ExportScopeValue | null>(null);

export function ExportScope({ value, children }: { value: ExportScopeValue; children: React.ReactNode }) {
  return <Scope.Provider value={value}>{children}</Scope.Provider>;
}

function href(
  scope: ExportScopeValue,
  extra: Record<string, string | undefined | null>,
  datasets: readonly string[] = [],
): string {
  const params = new URLSearchParams();
  for (const d of datasets) params.append('dataset', d);
  params.set('from', scope.from);
  params.set('to', scope.to);
  if (scope.model) params.set('model', scope.model);
  if (scope.source) params.set('source', scope.source);
  for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);
  return `/api/xlsx/${scope.slug}?${params.toString()}`;
}

const CLASS =
  'inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-[12px] font-medium text-text-2 ' +
  'hover:bg-canvas hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 print-hidden';

/**
 * "Export to Excel" on one card: the rows behind it, not its totals — one tab
 * per dataset, each `name` or `name:stage` (`deals:value` is the deals reaching
 * the counted stage).
 */
export function ExportButton({
  datasets,
  label = 'Export to Excel',
}: {
  datasets: readonly string[];
  label?: string;
}) {
  const scope = useContext(Scope);
  if (!scope) return null;
  return (
    <a
      href={href(scope, { platform: scope.platform }, datasets)}
      className={CLASS}
      download
      data-export={datasets.join(',')}
      title={label}
    >
      <FileSpreadsheet aria-hidden="true" className="h-3.5 w-3.5" />
      <span className="max-sm:sr-only">{label}</span>
    </a>
  );
}

/** "Export everything": one workbook, a tab per card on the page. */
export function ExportEverything() {
  const scope = useContext(Scope);
  if (!scope) return null;
  return (
    <a
      href={href(scope, { page: scope.page, platform: scope.platform })}
      className={`${CLASS} h-9 px-3 text-[13px] text-text`}
      download
      data-export="page"
    >
      <FileSpreadsheet aria-hidden="true" className="h-4 w-4" />
      Export everything
    </a>
  );
}
