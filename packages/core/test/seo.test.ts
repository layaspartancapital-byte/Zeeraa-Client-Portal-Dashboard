import { describe, expect, it } from 'vitest';
import {
  holdsAiOverview,
  intentLabels,
  maxUnitsPerRead,
  monthOf,
  plannedAnnualUnits,
  positionBands,
  positionMove,
  semrushDate,
  semrushReport,
  semrushReportDue,
  SEMRUSH_REPORTS,
} from '../src/seo';
import { improvementDirectionFor } from '../src/metric-direction';

describe('the Semrush budget', () => {
  it('stays under a third of the two-million-unit allowance, positions weekly for 80 keywords', () => {
    // 28 September 2026: positions cost 100 a keyword, so the user chose a
    // weekly read (daily positions, up to a week stale) at about 606,000 a year.
    expect(plannedAnnualUnits({ tracking: true, trackedKeywords: 80 })).toBe(605_700);
    expect(plannedAnnualUnits({ tracking: false })).toBe(153_200);
    expect(plannedAnnualUnits({ tracking: true, trackedKeywords: 80 })).toBeLessThan(2_000_000 / 3);
  });

  it('prices tracked positions per keyword, not per request', () => {
    expect(maxUnitsPerRead(semrushReport('tracking_positions'), 80)).toBe(8_000);
    expect(maxUnitsPerRead(semrushReport('tracking_visibility'))).toBe(100);
  });

  it('prices a per-line report by its lines and a per-request one by its requests', () => {
    expect(maxUnitsPerRead(semrushReport('top_keywords'))).toBe(2_000);
    expect(maxUnitsPerRead(semrushReport('referring_domains_new'))).toBe(4_000);
    expect(maxUnitsPerRead(semrushReport('backlinks_overview'))).toBe(40);
    expect(maxUnitsPerRead(semrushReport('domain_history'), 24)).toBe(240);
  });

  it('reads no site-audit history or snapshot detail, which Semrush prices at 10,000 a snapshot', () => {
    expect(SEMRUSH_REPORTS.every((r) => r.price <= 100)).toBe(true);
  });
});

describe('semrushReportDue', () => {
  it('is due when never read', () => {
    expect(semrushReportDue('monthly', null, '2026-09-28')).toBe(true);
  });
  it('reads daily reports once a day', () => {
    expect(semrushReportDue('daily', '2026-09-28', '2026-09-28')).toBe(false);
    expect(semrushReportDue('daily', '2026-09-27', '2026-09-28')).toBe(true);
  });
  it('reads weekly reports seven days apart', () => {
    expect(semrushReportDue('weekly', '2026-09-22', '2026-09-28')).toBe(false);
    expect(semrushReportDue('weekly', '2026-09-21', '2026-09-28')).toBe(true);
  });
  it('reads monthly reports once per calendar month, not every thirty days', () => {
    expect(semrushReportDue('monthly', '2026-09-30', '2026-10-01')).toBe(true);
    expect(semrushReportDue('monthly', '2026-09-01', '2026-09-30')).toBe(false);
  });
});

describe('dates and features', () => {
  it('reads Semrush dates and months', () => {
    expect(semrushDate('20260815')).toBe('2026-08-15');
    expect(semrushDate('garbage')).toBeNull();
    expect(monthOf('2026-09-28')).toBe('2026-09-01');
  });
  it('finds the AI Overview (52) in a feature list and not in 152 or 5', () => {
    expect(holdsAiOverview('6,7,21,36,52')).toBe(true);
    expect(holdsAiOverview('152,5')).toBe(false);
    expect(holdsAiOverview(null)).toBe(false);
  });
  it('names intents', () => {
    expect(intentLabels('1,2')).toEqual(['Informational', 'Navigational']);
  });
});

describe('positionBands', () => {
  it('counts cumulative bands and never gives an unranked keyword a position', () => {
    expect(positionBands([1, 3, 4, 10, 11, 20, 21, 100, null, 0])).toEqual({
      tracked: 10, top3: 2, top10: 4, top20: 6, top100: 8, notRanking: 2,
    });
  });
});

describe('positionMove', () => {
  it('treats a smaller position as better and leaving the top 100 as dropped', () => {
    expect(positionMove(8, 3)).toBe('improved');
    expect(positionMove(3, 8)).toBe('declined');
    expect(positionMove(5, 5)).toBe('unchanged');
    expect(positionMove(null, 40)).toBe('entered');
    expect(positionMove(40, null)).toBe('dropped');
    expect(positionMove(null, null)).toBe('absent');
  });
});

describe('SEO directions', () => {
  it('declares every SEO figure the page compares, so none renders neutral by omission', () => {
    for (const key of [
      'organic_keywords', 'estimated_organic_traffic', 'ai_overview_citations', 'referring_domains',
      'authority_score', 'site_health', 'tracked_visibility', 'tracked_top_10',
    ]) {
      expect(improvementDirectionFor(key)).toBe('up');
    }
  });
});
