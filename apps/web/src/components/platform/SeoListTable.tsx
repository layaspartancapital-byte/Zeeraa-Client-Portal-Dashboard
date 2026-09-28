'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { formatCount, intentLabels, positionMove } from '@zeeraa/core';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SEO_PAGE_SIZE, type SeoListKey, type SeoListRows } from '@/lib/seo-lists';

/**
 * One of the SEO page's long lists: the first 25 rows from the server, and
 * "Load more" for the next 25 at a time, fetched only when asked for.
 */
export function SeoListTable<K extends SeoListKey>({
  list,
  initial,
  total,
  head,
  minWidth,
  loadMore,
}: {
  list: K;
  initial: SeoListRows[K];
  /** Rows in the whole list, so the count reads "25 of 147". */
  total: number;
  head: string[];
  minWidth: number;
  loadMore: (list: SeoListKey, offset: number) => Promise<SeoListRows[SeoListKey]>;
}) {
  const [rows, setRows] = useState<SeoListRows[K]>(initial);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();
  const remaining = total - rows.length;

  const more = () =>
    start(async () => {
      try {
        const next = (await loadMore(list, rows.length)) as SeoListRows[K];
        setFailed(false);
        setRows((current) => [...current, ...next] as SeoListRows[K]);
      } catch {
        setFailed(true);
      }
    });

  return (
    <>
      <div className="scroll-x min-w-0 overflow-x-auto border-t border-border">
        <table className="w-full border-collapse text-[13px]" style={{ minWidth }}>
          <thead>
            <tr className="border-b border-border text-left text-[12px] font-semibold text-text-2">
              {head.map((h, i) => (
                <th key={h} scope="col" className={`${i === 0 ? 'px-5' : 'numeric px-3'} py-2.5 ${i === head.length - 1 ? 'pr-5' : ''}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => {
              const cells = cellsFor(list, row);
              return (
                <tr key={r} className="border-b border-border last:border-b-0">
                  {cells.map((cell, i) =>
                    i === 0 ? (
                      <th key={i} scope="row" className="max-w-[300px] px-5 py-2.5 text-left font-medium text-text">
                        {cell}
                      </th>
                    ) : (
                      <td key={i} className={`numeric px-3 py-2.5 tabular text-text-2 ${i === cells.length - 1 ? 'pr-5' : ''}`}>
                        {cell}
                      </td>
                    ),
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-2.5 text-[12px] text-text-3">
        <span className="tabular" aria-live="polite">
          {formatCount(rows.length)} of {formatCount(total)}
        </span>
        {remaining > 0 && (
          <span className="flex items-center gap-2">
            {failed && <span>Could not load more.</span>}
            <Button onClick={more} disabled={pending}>
              {pending ? 'Loading…' : `Load ${formatCount(Math.min(SEO_PAGE_SIZE, remaining))} more`}
            </Button>
          </span>
        )}
      </div>
    </>
  );
}

function cellsFor(list: SeoListKey, row: SeoListRows[SeoListKey][number]): ReactNode[] {
  switch (list) {
    case 'keywords': {
      const k = row as SeoListRows['keywords'][number];
      return [
        <span key="k" className="flex items-center gap-1.5">
          <span className="truncate" title={k.keyword}>{k.keyword}</span>
          {k.aiOverview && <Badge tone="neutral">AI Overview</Badge>}
          {intentLabels(k.intents).length > 0 && (
            <span className="sr-only">Intent: {intentLabels(k.intents).join(', ')}</span>
          )}
        </span>,
        String(k.position),
        <PositionChange key="c" before={k.previousPosition} after={k.position} />,
        formatCount(k.searchVolume),
        k.trafficShare === null ? '—' : `${k.trafficShare.toFixed(1)}%`,
        k.keywordDifficulty === null ? '—' : String(Math.round(k.keywordDifficulty)),
        <UrlCell key="u" url={k.url} />,
      ];
    }
    case 'tracked': {
      const k = row as SeoListRows['tracked'][number];
      return [
        <span key="k" className="truncate" title={k.keyword}>{k.keyword}</span>,
        k.searchVolume === null ? '—' : formatCount(k.searchVolume),
        k.start === null ? 'Not in top 100' : String(k.start),
        k.end === null ? 'Not in top 100' : String(k.end),
        <PositionChange key="c" before={k.start} after={k.end} />,
      ];
    }
    case 'competitors': {
      const c = row as SeoListRows['competitors'][number];
      return [
        <span key="d" className="truncate" title={c.domain}>{c.domain}</span>,
        formatCount(c.commonKeywords),
        formatCount(c.organicKeywords),
        formatCount(c.organicTraffic),
      ];
    }
    case 'new_domains':
    case 'lost_domains': {
      const d = row as SeoListRows['new_domains'][number];
      return [
        <span key="d" className="truncate" title={d.domain}>{d.domain}</span>,
        String(d.authorityScore),
        formatCount(d.backlinks),
        dayLabel(d.on),
      ];
    }
  }
}

/**
 * A position change. Whether it is an improvement is `positionMove` in core —
 * a smaller position is better — so the colour is the metric's, not the card's.
 */
function PositionChange({ before, after }: { before: number | null; after: number | null }) {
  const move = positionMove(before, after);
  if (move === 'absent' || move === 'unchanged') return <span className="text-text-3">—</span>;
  if (move === 'entered') return <span className="text-text-2">New</span>;
  if (move === 'dropped') return <span className="text-down-text">Dropped out</span>;
  const places = Math.abs((before ?? 0) - (after ?? 0));
  return (
    <span className={move === 'improved' ? 'text-up-text' : 'text-down-text'}>
      {move === 'improved' ? '▲' : '▼'} {places}
      <span className="sr-only">{move === 'improved' ? ' places up' : ' places down'}</span>
    </span>
  );
}

export function UrlCell({ url }: { url: string }) {
  const path = url.replace(/^https?:\/\/[^/]+/, '') || '/';
  return (
    <span className="block max-w-[220px] truncate text-text-2" title={url}>
      {path}
    </span>
  );
}

const DAY = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function dayLabel(day: string): string {
  return DAY.format(new Date(`${day}T00:00:00Z`));
}
