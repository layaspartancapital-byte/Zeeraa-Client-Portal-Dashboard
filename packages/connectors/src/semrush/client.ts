/**
 * A client for the Semrush API: the analytics reports (CSV), backlinks (CSV)
 * and the Projects reports (JSON) — Site Audit and Position Tracking.
 *
 * One API key, Zeeraa's, metered in units across every client, so the key is
 * the environment's (`SEMRUSH_API_KEY`) and not a per-tenant credential; what
 * is per tenant is the project and campaign ids on the connection row.
 *
 * Every method returns parsed rows and nothing else. What a read cost is
 * measured by the caller from `balance()`, which is free, because Semrush's
 * charge is not always its published price (see `SEMRUSH_REPORTS` in core).
 */

const ANALYTICS = 'https://api.semrush.com/';
const BACKLINKS = 'https://api.semrush.com/analytics/v1/';
const PROJECTS = 'https://api.semrush.com/reports/v1/projects/';
const BALANCE = 'https://www.semrush.com/users/countapiunits.html';

export class SemrushApiError extends Error {
  constructor(
    readonly status: number,
    readonly report: string,
    readonly detail: string,
  ) {
    super(`Semrush ${report}: ${detail}`);
    this.name = 'SemrushApiError';
  }

  /** No retry fixes an empty balance or a bad key. */
  get fatal(): boolean {
    return /UNITS BALANCE IS ZERO|WRONG KEY|INVALID KEY|FORBIDDEN|ACCESS DENIED/i.test(this.detail);
  }
}

export type SemrushDomainRank = {
  rank: number | null;
  organicKeywords: number;
  positions1to3: number;
  positions4to10: number;
  positions11to20: number;
  organicTraffic: number;
  organicTrafficCost: number;
  aiOverviewKeywords: number;
  aiOverviewCited: number;
};

export type SemrushDomainRankMonth = SemrushDomainRank & { date: string };

export type SemrushKeywordRow = {
  keyword: string;
  position: number;
  previousPosition: number | null;
  searchVolume: number;
  cpc: number | null;
  url: string;
  trafficShare: number | null;
  keywordDifficulty: number | null;
  intents: string | null;
  serpFeatures: string | null;
  serpFeaturesHeld: string | null;
};

export type SemrushCompetitorRow = {
  domain: string;
  relevance: number;
  commonKeywords: number;
  organicKeywords: number;
  organicTraffic: number;
  organicTrafficCost: number;
};

export type SemrushBacklinksOverview = {
  authorityScore: number;
  backlinks: number;
  referringDomains: number;
  followBacklinks: number;
  nofollowBacklinks: number;
};

export type SemrushBacklinksMonth = {
  /** Epoch seconds, as Semrush reports it. */
  at: number;
  authorityScore: number;
  backlinks: number;
  referringDomains: number;
};

export type SemrushReferringDomain = {
  domain: string;
  authorityScore: number;
  backlinks: number;
  /** Epoch seconds. The caller turns these into tenant days. */
  firstSeen: number;
  lastSeen: number;
};

export type SemrushSiteAuditIssue = {
  id: number;
  severity: 'error' | 'warning' | 'notice';
  count: number;
  delta: number;
};

export type SemrushSiteAudit = {
  snapshotId: string;
  /** Epoch milliseconds. */
  finishedAt: number;
  healthScore: number;
  aiSearchScore: number | null;
  thematicScores: Record<string, number>;
  pagesCrawled: number;
  pagesLimit: number;
  errors: number;
  warnings: number;
  notices: number;
  issues: SemrushSiteAuditIssue[];
};

export type SemrushTrackedPosition = {
  keyword: string;
  day: string;
  position: number | null;
  url: string | null;
  searchVolume: number | null;
};

export type SemrushVisibilityDay = { day: string; visibility: number };

export class SemrushClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!apiKey) throw new Error('SEMRUSH_API_KEY is not set.');
  }

  /** Units left on the account. Free to call. Null when it does not answer a number. */
  async balance(): Promise<number | null> {
    const res = await this.fetchImpl(`${BALANCE}?key=${encodeURIComponent(this.apiKey)}`);
    const text = (await res.text()).trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  }

  async domainRank(domain: string, database: string): Promise<SemrushDomainRank | null> {
    const rows = await this.analytics('domain_rank', {
      domain,
      database,
      export_columns: 'Rk,Or,X0,X1,X2,Ot,Oc,FK52,FP52',
    });
    return rows[0] ? domainRankRow(rows[0]) : null;
  }

  /** Semrush's monthly figures, newest first. */
  async domainRankHistory(domain: string, database: string, months: number): Promise<SemrushDomainRankMonth[]> {
    const rows = await this.analytics('domain_rank_history', {
      domain,
      database,
      display_limit: String(months),
      export_columns: 'Dt,Rk,Or,X0,X1,X2,Ot,Oc,FK52,FP52',
    });
    return rows.map((r) => ({ date: r[0] ?? '', ...domainRankRow(r.slice(1)) }));
  }

  /** The domain's keywords, largest share of estimated traffic first. */
  async topKeywords(domain: string, database: string, limit: number): Promise<SemrushKeywordRow[]> {
    const rows = await this.analytics('domain_organic', {
      domain,
      database,
      display_limit: String(limit),
      display_sort: 'tr_desc',
      export_columns: 'Ph,Po,Pp,Nq,Cp,Ur,Tr,Kd,In,Fk,Fp',
    });
    return rows.map(keywordRow);
  }

  /**
   * Keywords where the domain holds a SERP-feature position, narrowed to the
   * AI Overview. `display_positions_type=serp_features` is what isolates
   * them; a filter on `Fp` is silently ignored by the API.
   */
  async serpFeatureKeywords(domain: string, database: string, limit: number): Promise<SemrushKeywordRow[]> {
    const rows = await this.analytics('domain_organic', {
      domain,
      database,
      display_limit: String(limit),
      display_positions_type: 'serp_features',
      display_sort: 'nq_desc',
      export_columns: 'Ph,Po,Pp,Nq,Cp,Ur,Tr,Kd,In,Fk,Fp',
    });
    return rows.map(keywordRow);
  }

  async organicCompetitors(domain: string, database: string, limit: number): Promise<SemrushCompetitorRow[]> {
    const rows = await this.analytics('domain_organic_organic', {
      domain,
      database,
      display_limit: String(limit),
      export_columns: 'Dn,Cr,Np,Or,Ot,Oc',
    });
    return rows.map((r) => ({
      domain: r[0] ?? '',
      relevance: num(r[1]),
      commonKeywords: int(r[2]),
      organicKeywords: int(r[3]),
      organicTraffic: int(r[4]),
      organicTrafficCost: num(r[5]),
    }));
  }

  async backlinksOverview(target: string): Promise<SemrushBacklinksOverview | null> {
    const rows = await this.backlinks('backlinks_overview', {
      target,
      target_type: 'root_domain',
      export_columns: 'ascore,total,domains_num,follows_num,nofollows_num',
    });
    const r = rows[0];
    if (!r) return null;
    return {
      authorityScore: int(r[0]),
      backlinks: int(r[1]),
      referringDomains: int(r[2]),
      followBacklinks: int(r[3]),
      nofollowBacklinks: int(r[4]),
    };
  }

  async backlinksHistory(target: string, months: number): Promise<SemrushBacklinksMonth[]> {
    const rows = await this.backlinks('backlinks_historical', {
      target,
      target_type: 'root_domain',
      display_limit: String(months),
      export_columns: 'date,score,backlinks_num,domains_num',
    });
    return rows.map((r) => ({
      at: int(r[0]),
      authorityScore: int(r[1]),
      backlinks: int(r[2]),
      referringDomains: int(r[3]),
    }));
  }

  /** Newest first: new by when first seen, lost by when last seen. */
  async referringDomains(target: string, change: 'new' | 'lost', limit: number): Promise<SemrushReferringDomain[]> {
    const rows = await this.backlinks('backlinks_refdomains', {
      target,
      target_type: 'root_domain',
      display_limit: String(limit),
      display_sort: change === 'new' ? 'first_seen_desc' : 'last_seen_desc',
      display_filter: `+|type||${change === 'new' ? 'newdomain' : 'lostdomain'}`,
      export_columns: 'domain_ascore,domain,backlinks_num,first_seen,last_seen',
    });
    return rows.map((r) => ({
      authorityScore: int(r[0]),
      domain: r[1] ?? '',
      backlinks: int(r[2]),
      firstSeen: int(r[3]),
      lastSeen: int(r[4]),
    }));
  }

  /** The latest crawl: health, thematic scores and every issue count. 100 units. */
  async siteAudit(projectId: number): Promise<SemrushSiteAudit | null> {
    const info = await this.projects<SiteAuditInfo>(`${projectId}/siteaudit/info`, {}, 'site_audit');
    return parseSiteAudit(info);
  }

  /** Issue id → its name. 100 units. */
  async siteAuditIssueTitles(projectId: number): Promise<Map<number, string>> {
    const meta = await this.projects<{ issues?: { id: number; title: string }[] }>(
      `${projectId}/siteaudit/meta/issues`,
      {},
      'site_audit_issues',
    );
    return new Map((meta.issues ?? []).map((i) => [i.id, i.title]));
  }

  /**
   * Every tracked keyword's position on the days in the range. 100 units a
   * page. `url` is the tracked domain with Semrush's mask, e.g.
   * `*.spartancapitalgroup.com/*`.
   */
  async trackedPositions(
    campaignId: string,
    url: string,
    range: { start: string; end: string },
    page: { limit: number; offset: number },
  ): Promise<{ total: number | null; rows: SemrushTrackedPosition[] }> {
    const body = await this.projects<unknown>(
      `${campaignId}/tracking/`,
      {
        action: 'report',
        type: 'tracking_position_organic',
        url,
        date_begin: compact(range.start),
        date_end: compact(range.end),
        display_limit: String(page.limit),
        display_offset: String(page.offset),
        linktype_filter: '0',
      },
      'tracking_positions',
    );
    return parseTrackedPositions(body, url);
  }

  async trackedVisibility(
    campaignId: string,
    url: string,
    range: { start: string; end: string },
  ): Promise<SemrushVisibilityDay[]> {
    const body = await this.projects<unknown>(
      `${campaignId}/tracking/`,
      {
        action: 'report',
        type: 'tracking_visibility_organic',
        url,
        date_begin: compact(range.start),
        date_end: compact(range.end),
      },
      'tracking_visibility',
    );
    return parseVisibility(body);
  }

  private async analytics(type: string, params: Record<string, string>): Promise<string[][]> {
    return this.csv(ANALYTICS, type, params);
  }

  private async backlinks(type: string, params: Record<string, string>): Promise<string[][]> {
    return this.csv(BACKLINKS, type, params);
  }

  private async csv(base: string, type: string, params: Record<string, string>): Promise<string[][]> {
    const query = new URLSearchParams({ type, key: this.apiKey, ...params });
    const res = await this.fetchImpl(`${base}?${query}`);
    const text = await res.text();
    return parseSemrushCsv(text, type, res.status);
  }

  private async projects<T>(path: string, params: Record<string, string>, report: string): Promise<T> {
    const query = new URLSearchParams({ key: this.apiKey, ...params });
    const res = await this.fetchImpl(`${PROJECTS}${path}?${query}`);
    const text = await res.text();
    if (!res.ok) throw new SemrushApiError(res.status, report, text.slice(0, 300));
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SemrushApiError(res.status, report, `not JSON: ${text.slice(0, 200)}`);
    }
  }
}

/**
 * Semrush's CSV: semicolon-separated, a header line, no quoting. `ERROR 50 ::
 * NOTHING FOUND` is an empty answer, not a failure — a domain with no new
 * referring domains this month is a fact. Any other `ERROR` is thrown.
 */
export function parseSemrushCsv(text: string, report: string, status = 200): string[][] {
  const body = text.trim();
  if (/^ERROR 50 ::/.test(body)) return [];
  if (/^ERROR \d+ ::/.test(body) || /^Validation Error/i.test(body) || status >= 400) {
    throw new SemrushApiError(status, report, body.slice(0, 300));
  }
  const lines = body.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const width = lines[0]!.split(';').length;
  // Semrush does not quote, so a value holding a semicolon arrives as extra
  // cells and every column after it would shift. Such a row is dropped rather
  // than stored misaligned; none has been seen in Spartan's data.
  return lines
    .slice(1)
    .map((line) => line.split(';'))
    .filter((cells) => cells.length === width);
}

function domainRankRow(r: string[]): SemrushDomainRank {
  return {
    rank: r[0] ? int(r[0]) : null,
    organicKeywords: int(r[1]),
    positions1to3: int(r[2]),
    positions4to10: int(r[3]),
    positions11to20: int(r[4]),
    organicTraffic: int(r[5]),
    organicTrafficCost: num(r[6]),
    aiOverviewKeywords: int(r[7]),
    aiOverviewCited: int(r[8]),
  };
}

function keywordRow(r: string[]): SemrushKeywordRow {
  return {
    keyword: r[0] ?? '',
    position: int(r[1]),
    previousPosition: r[2] && r[2] !== '0' ? int(r[2]) : null,
    searchVolume: int(r[3]),
    cpc: r[4] ? num(r[4]) : null,
    url: r[5] ?? '',
    trafficShare: r[6] ? num(r[6]) : null,
    keywordDifficulty: r[7] ? num(r[7]) : null,
    intents: r[8] || null,
    serpFeatures: r[9] || null,
    serpFeaturesHeld: r[10] || null,
  };
}

type SiteAuditInfo = {
  errors?: number;
  warnings?: number;
  notices?: number;
  pages_crawled?: number;
  pages_limit?: number;
  current_snapshot?: {
    snapshot_id?: string;
    finish_date?: number;
    quality?: { value?: number };
    aiSearchScore?: { value?: number };
    thematicScores?: Record<string, { value?: number }> | null;
    pages_crawled?: number;
    pages_limit?: number;
    errors?: { id: number; count: number; delta?: number }[];
    warnings?: { id: number; count: number; delta?: number }[];
    notices?: { id: number; count: number; delta?: number }[];
  } | null;
};

export function parseSiteAudit(info: SiteAuditInfo): SemrushSiteAudit | null {
  const s = info.current_snapshot;
  if (!s?.snapshot_id || typeof s.finish_date !== 'number' || typeof s.quality?.value !== 'number') {
    return null;
  }
  const thematicScores: Record<string, number> = {};
  for (const [name, score] of Object.entries(s.thematicScores ?? {})) {
    if (typeof score?.value === 'number') thematicScores[name] = score.value;
  }
  const issues: SemrushSiteAuditIssue[] = [];
  for (const severity of ['error', 'warning', 'notice'] as const) {
    for (const issue of s[`${severity}s`] ?? []) {
      // Checks that found nothing are not issues; storing them would be ninety
      // rows of zeroes per crawl.
      if (issue.count > 0) {
        issues.push({ id: issue.id, severity, count: issue.count, delta: issue.delta ?? 0 });
      }
    }
  }
  return {
    snapshotId: s.snapshot_id,
    finishedAt: s.finish_date,
    healthScore: s.quality.value,
    aiSearchScore: typeof s.aiSearchScore?.value === 'number' ? s.aiSearchScore.value : null,
    thematicScores,
    pagesCrawled: s.pages_crawled ?? info.pages_crawled ?? 0,
    pagesLimit: s.pages_limit ?? info.pages_limit ?? 0,
    errors: info.errors ?? 0,
    warnings: info.warnings ?? 0,
    notices: info.notices ?? 0,
    issues,
  };
}

/**
 * Position Tracking's organic positions.
 *
 * Its rows carry per-day values keyed `YYYYMMDD`, nested with the tracked URL
 * mask: `Dt: { "20260928": { "*.example.com/*": 3 } }`, and landing URLs in
 * `Lu` the same way. Both nestings (date→mask and mask→date) are read, since
 * the documentation shows one and responses have shown the other; a position
 * of 0 or a non-number is "not in the top 100", never position zero.
 */
export function parseTrackedPositions(
  body: unknown,
  mask: string,
): { total: number | null; rows: SemrushTrackedPosition[] } {
  const b = (body ?? {}) as { total?: unknown; data?: unknown };
  const data = b.data;
  const list: Record<string, unknown>[] = Array.isArray(data)
    ? (data as Record<string, unknown>[])
    : data && typeof data === 'object'
      ? (Object.values(data) as Record<string, unknown>[])
      : [];
  const rows: SemrushTrackedPosition[] = [];
  for (const item of list) {
    const keyword = typeof item.Ph === 'string' ? item.Ph : null;
    if (!keyword) continue;
    const positions = byDay(item.Dt, mask);
    const urls = byDay(item.Lu, mask);
    const volume = item.Nq === undefined || item.Nq === null ? null : int(String(item.Nq));
    for (const [day, value] of positions) {
      const position = typeof value === 'number' ? value : Number(value);
      rows.push({
        keyword,
        day,
        position: Number.isFinite(position) && position >= 1 && position <= 100 ? Math.trunc(position) : null,
        url: typeof urls.get(day) === 'string' && urls.get(day) !== '' ? (urls.get(day) as string) : null,
        searchVolume: volume,
      });
    }
  }
  const total = typeof b.total === 'number' ? b.total : b.total ? Number(b.total) : null;
  return { total: Number.isFinite(total) ? total : null, rows };
}

/**
 * The campaign's visibility by day: rows of `{ Dt: "20260901", Vr: 5.90968,
 * Vi: 1720900, Av: 84.51 }`. `Vr` is the percentage Semrush's own screen shows
 * as Visibility; `Vi` is its unscaled form and is not stored.
 */
export function parseVisibility(body: unknown): SemrushVisibilityDay[] {
  const data = (body ?? {}) as { data?: unknown };
  const list = Array.isArray(data.data)
    ? (data.data as Record<string, unknown>[])
    : data.data && typeof data.data === 'object'
      ? (Object.values(data.data) as Record<string, unknown>[])
      : [];
  const out: SemrushVisibilityDay[] = [];
  for (const row of list) {
    const day = typeof row.Dt === 'string' || typeof row.Dt === 'number' ? String(row.Dt) : '';
    const visibility = Number(row.Vr);
    if (/^\d{8}$/.test(day) && Number.isFinite(visibility)) out.push({ day: dashed(day), visibility });
  }
  return out.sort((x, y) => x.day.localeCompare(y.day));
}

function byDay(value: unknown, mask: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!value || typeof value !== 'object') return out;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (/^\d{8}$/.test(key)) {
      // date → { mask: value } or date → value
      out.set(dashed(key), inner && typeof inner === 'object' ? pick(inner as Record<string, unknown>, mask) : inner);
    } else if (inner && typeof inner === 'object') {
      // mask → { date: value }
      if (key !== mask && Object.keys(value as object).length > 1) continue;
      for (const [d, v] of Object.entries(inner as Record<string, unknown>)) {
        if (/^\d{8}$/.test(d)) out.set(dashed(d), v);
      }
    }
  }
  return out;
}

function pick(obj: Record<string, unknown>, mask: string): unknown {
  if (mask in obj) return obj[mask];
  const values = Object.values(obj);
  return values.length === 1 ? values[0] : undefined;
}

function compact(day: string): string {
  return day.replaceAll('-', '');
}

function dashed(day: string): string {
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
}

function int(value: string | undefined): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

function num(value: string | undefined): number {
  const n = Number.parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
}
