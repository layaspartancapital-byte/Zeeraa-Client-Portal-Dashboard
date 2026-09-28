import { describe, expect, it } from 'vitest';
import { isSeoList, seoListPage, SEO_PAGE_SIZE } from '../src/lib/seo-lists';
import type { SeoView } from '../src/lib/seo';

const keyword = (i: number) => ({
  keyword: `k${i}`, position: i, previousPosition: null, searchVolume: 1, url: '/', trafficShare: null,
  keywordDifficulty: null, intents: null, aiOverview: false,
});
const view = {
  topKeywords: { rows: Array.from({ length: 147 }, (_, i) => keyword(i)), month: null, readOn: null, read: 147 },
  tracking: null,
  competitors: { rows: [], readOn: null },
  newDomains: { rows: [], inRange: 0, completeFrom: null, readOn: null },
  lostDomains: { rows: [], inRange: 0, completeFrom: null, readOn: null },
} as unknown as SeoView;

describe('the SEO page’s long lists', () => {
  it('pages 25 at a time, in the report’s order, to the end', () => {
    expect(SEO_PAGE_SIZE).toBe(25);
    expect(seoListPage(view, 'keywords', 0).map((k) => k.keyword)).toEqual(Array.from({ length: 25 }, (_, i) => `k${i}`));
    expect(seoListPage(view, 'keywords', 25)[0]!.keyword).toBe('k25');
    expect(seoListPage(view, 'keywords', 125)).toHaveLength(22);
    expect(seoListPage(view, 'keywords', 147)).toEqual([]);
  });

  it('reads a bad offset as the first page, and an absent list as empty', () => {
    expect(seoListPage(view, 'keywords', -5)[0]!.keyword).toBe('k0');
    expect(seoListPage(view, 'tracked', 0)).toEqual([]);
  });

  it('accepts only the five list names from the browser', () => {
    expect(isSeoList('keywords')).toBe(true);
    expect(isSeoList('audit_issues')).toBe(false);
    expect(isSeoList(undefined)).toBe(false);
  });
});
