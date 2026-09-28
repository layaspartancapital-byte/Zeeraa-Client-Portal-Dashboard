import type { SeoView } from '@/lib/seo';

/**
 * The SEO page's long lists, paged 25 at a time.
 *
 * The page sends the first page of each; "Load more" asks a server action for
 * the next, which slices the same cached `seoView` — so a later page is never
 * computed in a different order from the first, and rows nobody asked for
 * never reach the browser.
 */
export const SEO_PAGE_SIZE = 25;

export const SEO_LISTS = ['keywords', 'tracked', 'competitors', 'new_domains', 'lost_domains'] as const;
export type SeoListKey = (typeof SEO_LISTS)[number];

export type SeoListRows = {
  keywords: SeoView['topKeywords']['rows'];
  tracked: NonNullable<SeoView['tracking']>['keywords'];
  competitors: SeoView['competitors']['rows'];
  new_domains: SeoView['newDomains']['rows'];
  lost_domains: SeoView['lostDomains']['rows'];
};

export type SeoListRow = SeoListRows[SeoListKey][number];

export function isSeoList(value: unknown): value is SeoListKey {
  return typeof value === 'string' && (SEO_LISTS as readonly string[]).includes(value);
}

/** Every row of one list, in the order the page shows it. */
export function seoListRows<K extends SeoListKey>(view: SeoView, list: K): SeoListRows[K] {
  const rows: SeoListRows = {
    keywords: view.topKeywords.rows,
    tracked: view.tracking?.keywords ?? [],
    competitors: view.competitors.rows,
    new_domains: view.newDomains.rows,
    lost_domains: view.lostDomains.rows,
  };
  return rows[list];
}

/** One page of a list. A negative or fractional offset is read as the nearest page start. */
export function seoListPage<K extends SeoListKey>(view: SeoView, list: K, offset: number): SeoListRows[K] {
  const start = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  return seoListRows(view, list).slice(start, start + SEO_PAGE_SIZE) as SeoListRows[K];
}
