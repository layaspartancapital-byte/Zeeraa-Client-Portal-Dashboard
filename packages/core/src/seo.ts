import { addDays } from './dates';

/**
 * SEO from Semrush: what is read, how often, and what it costs.
 *
 * Semrush meters its API in units against Zeeraa's account, not per client,
 * so the reads are budgeted here as data and the sync spends against this
 * table rather than against whatever a call site thought reasonable. The
 * prices are Semrush's published ones (28 September 2026) and were checked
 * against the account balance before and after a real call of each report.
 *
 * **Site audit history and snapshot detail are deliberately absent.** Semrush
 * prices a snapshot at 10,000 units and bills its history per snapshot: one
 * exploratory `history?limit=5` call cost 50,000. `info` carries the health
 * score, the thematic scores and every issue count for 100, so nothing on the
 * page needs the others.
 */

export type SemrushCadence = 'daily' | 'weekly' | 'monthly' | 'once';

export type SemrushReport = {
  key: SemrushReportKey;
  /** What the report is, for the log and the method notes. */
  label: string;
  cadence: SemrushCadence;
  /** Units per request, or per returned line where `perLine`. */
  price: number;
  perLine: boolean;
  /** Lines asked for (per-line reports) or requests made (per-request ones). */
  lines: number;
  /** Needs a Position Tracking campaign id on the connection. */
  tracking?: boolean;
};

export type SemrushReportKey =
  | 'domain_overview'
  | 'domain_history'
  | 'top_keywords'
  | 'ai_overview_keywords'
  | 'competitors'
  | 'backlinks_overview'
  | 'backlinks_history'
  | 'referring_domains_new'
  | 'referring_domains_lost'
  | 'site_audit'
  | 'tracking_positions'
  | 'tracking_visibility';

export const SEMRUSH_REPORTS: readonly SemrushReport[] = [
  { key: 'domain_overview', label: 'Domain overview', cadence: 'weekly', price: 10, perLine: true, lines: 1 },
  // Semrush's own monthly figures: the previous month, finalised. The first
  // read asks for two years to draw the trend from.
  { key: 'domain_history', label: 'Domain history', cadence: 'monthly', price: 10, perLine: true, lines: 2 },
  { key: 'top_keywords', label: 'Top organic keywords', cadence: 'monthly', price: 10, perLine: true, lines: 200 },
  { key: 'ai_overview_keywords', label: 'AI Overview citations', cadence: 'monthly', price: 10, perLine: true, lines: 100 },
  { key: 'competitors', label: 'Organic competitors', cadence: 'monthly', price: 40, perLine: true, lines: 20 },
  { key: 'backlinks_overview', label: 'Backlinks summary', cadence: 'weekly', price: 40, perLine: false, lines: 1 },
  { key: 'backlinks_history', label: 'Backlinks history', cadence: 'monthly', price: 40, perLine: true, lines: 2 },
  { key: 'referring_domains_new', label: 'New referring domains', cadence: 'monthly', price: 40, perLine: true, lines: 100 },
  { key: 'referring_domains_lost', label: 'Lost referring domains', cadence: 'monthly', price: 40, perLine: true, lines: 100 },
  // Plus 100 for the issue names, once per new crawl (about fortnightly).
  { key: 'site_audit', label: 'Site audit', cadence: 'weekly', price: 100, perLine: false, lines: 1 },
  // 100 units per tracked keyword per call, whatever the number of days
  // (measured 28 September 2026; the documentation says per request). One call
  // returns every day since the last read, so a weekly read still stores
  // daily positions — the choice is freshness, not resolution. `lines` is the
  // campaign's keyword count, `trackedKeywords` on the connection.
  { key: 'tracking_positions', label: 'Tracked positions', cadence: 'weekly', price: 100, perLine: true, lines: 80, tracking: true },
  // 100 per request for any number of days (measured): the daily headline.
  { key: 'tracking_visibility', label: 'Tracked visibility', cadence: 'daily', price: 100, perLine: false, lines: 1, tracking: true },
];

/** How many lines the first read of a history report asks for. */
export const SEMRUSH_HISTORY_MONTHS = 24;

/** The issue-names call a new crawl adds to `site_audit`. */
export const SEMRUSH_ISSUE_TITLES_PRICE = 100;

export function semrushReport(key: SemrushReportKey): SemrushReport {
  const report = SEMRUSH_REPORTS.find((r) => r.key === key);
  if (!report) throw new Error(`Unknown Semrush report ${key}`);
  return report;
}

/** The most one read of this report can cost. The budget checks this before calling. */
export function maxUnitsPerRead(report: SemrushReport, lines = report.lines): number {
  return report.perLine ? report.price * lines : report.price * Math.max(1, lines);
}

const READS_PER_YEAR: Record<SemrushCadence, number> = { daily: 365, weekly: 52, monthly: 12, once: 1 };

/**
 * The year's ceiling, every report at its row cap. Actual spend is lower —
 * a per-line report bills only the lines that come back.
 */
export function plannedAnnualUnits(options: { tracking: boolean; trackedKeywords?: number }): number {
  const reads = SEMRUSH_REPORTS.filter((r) => options.tracking || !r.tracking).reduce(
    (sum, r) =>
      sum +
      maxUnitsPerRead(r, r.key === 'tracking_positions' ? (options.trackedKeywords ?? r.lines) : r.lines) *
        READS_PER_YEAR[r.cadence],
    0,
  );
  // A crawl about every two weeks, each wanting its issue names.
  return reads + 26 * SEMRUSH_ISSUE_TITLES_PRICE;
}

/**
 * Whether a report is due, given the tenant-local day of its last read.
 *
 * Monthly means once per calendar month, not every 30 days: a monthly
 * snapshot is keyed on its month, and a read on the 31st followed by one on
 * the 1st is two months, each read once.
 */
export function semrushReportDue(
  cadence: SemrushCadence,
  lastReadOn: string | null,
  today: string,
): boolean {
  if (lastReadOn === null) return true;
  switch (cadence) {
    case 'daily':
      return lastReadOn < today;
    case 'weekly':
      return addDays(lastReadOn, 7) <= today;
    case 'monthly':
      return lastReadOn.slice(0, 7) < today.slice(0, 7);
    case 'once':
      return false;
  }
}

/** The first day of the month a day falls in. */
export function monthOf(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** Semrush's analytics dates: `20260815` → `2026-08-15`. */
export function semrushDate(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * The SERP feature code for Google's AI Overview in Semrush's analytics
 * reports (`FK52` / `FP52`, and `52` in a keyword's feature list).
 */
export const AI_OVERVIEW_FEATURE = '52';

/** Whether a Semrush feature list (`"6,7,21,52"`) includes the AI Overview. */
export function holdsAiOverview(features: string | null | undefined): boolean {
  return (features ?? '')
    .split(',')
    .map((f) => f.trim())
    .includes(AI_OVERVIEW_FEATURE);
}

export type PositionBands = {
  tracked: number;
  top3: number;
  top10: number;
  top20: number;
  top100: number;
  /** Tracked and not in the top 100 that day. Counted, never given a position. */
  notRanking: number;
};

/**
 * Tracked keywords by where they ranked on one day. Cumulative bands — a
 * keyword at position 2 is in the top 3 *and* the top 10 — because that is
 * how Semrush states them and how a reader asks ("how many on page one?").
 */
export function positionBands(positions: readonly (number | null)[]): PositionBands {
  const bands: PositionBands = { tracked: 0, top3: 0, top10: 0, top20: 0, top100: 0, notRanking: 0 };
  for (const p of positions) {
    bands.tracked += 1;
    if (p === null || !(p >= 1) || p > 100) {
      bands.notRanking += 1;
      continue;
    }
    bands.top100 += 1;
    if (p <= 20) bands.top20 += 1;
    if (p <= 10) bands.top10 += 1;
    if (p <= 3) bands.top3 += 1;
  }
  return bands;
}

export type PositionMove = 'improved' | 'declined' | 'unchanged' | 'entered' | 'dropped' | 'absent';

/**
 * How a tracked keyword moved between two days. A smaller position is
 * better; leaving the top 100 is `dropped`, not a move to position 101.
 */
export function positionMove(before: number | null, after: number | null): PositionMove {
  if (before === null && after === null) return 'absent';
  if (before === null) return 'entered';
  if (after === null) return 'dropped';
  if (after < before) return 'improved';
  if (after > before) return 'declined';
  return 'unchanged';
}

/** Semrush's search-intent codes, as it names them. */
export const SEMRUSH_INTENTS: Record<string, string> = {
  '0': 'Commercial',
  '1': 'Informational',
  '2': 'Navigational',
  '3': 'Transactional',
};

export function intentLabels(codes: string | null | undefined): string[] {
  return (codes ?? '')
    .split(',')
    .map((c) => SEMRUSH_INTENTS[c.trim()])
    .filter((l): l is string => Boolean(l));
}
