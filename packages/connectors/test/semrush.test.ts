import { describe, expect, it } from 'vitest';
import {
  parseSemrushCsv,
  parseSiteAudit,
  parseTrackedPositions,
  parseVisibility,
  SemrushApiError,
  SemrushClient,
} from '../src/semrush/client';

/** Responses as Semrush returned them for spartancapitalgroup.com, 28 September 2026. */
const DOMAIN_RANK =
  'Rank;Organic Keywords;X0;X1;X2;Organic Traffic;Organic Cost;AI overview;AI overview\n' +
  '1499359;1607;17;56;93;652;6982;1337;26\n';
const ORGANIC =
  'Keyword;Position;Previous Position;Search Volume;CPC;Url;Traffic (%);Keyword Difficulty;Intents;SERP Features by Keyword;SERP Features by Position\n' +
  'spartan capital;1;1;1600;13.51;https://www.spartancapitalgroup.com/;32.36;41.00;1;6,7,21,36,52;6\n';

function fakeFetch(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe('parseSemrushCsv', () => {
  it('treats NOTHING FOUND as an empty answer', () => {
    expect(parseSemrushCsv('ERROR 50 :: NOTHING FOUND\n', 'x')).toEqual([]);
  });
  it('throws any other error, and marks an empty balance fatal', () => {
    expect(() => parseSemrushCsv('ERROR 132 :: API UNITS BALANCE IS ZERO', 'x')).toThrow(SemrushApiError);
    try {
      parseSemrushCsv('ERROR 132 :: API UNITS BALANCE IS ZERO', 'x');
    } catch (e) {
      expect((e as SemrushApiError).fatal).toBe(true);
    }
    expect(() => parseSemrushCsv('Validation Error : display_filter: nope', 'x')).toThrow(SemrushApiError);
  });
  it('drops a row whose cells do not match the header rather than shifting its columns', () => {
    expect(parseSemrushCsv('A;B\n1;2\n1;2;3\n', 'x')).toEqual([['1', '2']]);
  });
});

describe('SemrushClient', () => {
  it('reads the domain overview, including the AI Overview columns', async () => {
    const rank = await new SemrushClient('k', fakeFetch(DOMAIN_RANK)).domainRank('spartancapitalgroup.com', 'us');
    expect(rank).toEqual({
      rank: 1499359, organicKeywords: 1607, positions1to3: 17, positions4to10: 56, positions11to20: 93,
      organicTraffic: 652, organicTrafficCost: 6982, aiOverviewKeywords: 1337, aiOverviewCited: 26,
    });
  });

  it('reads a keyword row, with a previous position of 0 as none', async () => {
    const [row] = await new SemrushClient('k', fakeFetch(ORGANIC.replace(';1;1;1600', ';1;0;1600'))).topKeywords('d', 'us', 1);
    expect(row).toMatchObject({ keyword: 'spartan capital', position: 1, previousPosition: null, searchVolume: 1600, serpFeaturesHeld: '6' });
  });

  it('reads the balance, and null for anything but a number', async () => {
    expect(await new SemrushClient('k', fakeFetch('1948210')).balance()).toBe(1948210);
    expect(await new SemrushClient('k', fakeFetch('<html>')).balance()).toBeNull();
  });

  it('refuses to exist without a key', () => {
    expect(() => new SemrushClient('')).toThrow(/SEMRUSH_API_KEY/);
  });
});

describe('parseSiteAudit', () => {
  it('keeps the health score, thematic scores and only the issues found', () => {
    const audit = parseSiteAudit({
      errors: 2, warnings: 11196, notices: 11, pages_crawled: 5600, pages_limit: 10000,
      current_snapshot: {
        snapshot_id: '6ab07c75d29f71103c125de9', finish_date: 1789954179301,
        quality: { value: 93 }, aiSearchScore: { value: 99 },
        thematicScores: { crawlability: { value: 97 }, https: { value: 100 } },
        errors: [{ id: 1, count: 0 }, { id: 2, count: 1, delta: 0 }],
        warnings: [{ id: 12, count: 5595, delta: 3 }],
        notices: [],
      },
    });
    expect(audit).toMatchObject({
      snapshotId: '6ab07c75d29f71103c125de9', healthScore: 93, aiSearchScore: 99,
      thematicScores: { crawlability: 97, https: 100 }, errors: 2, warnings: 11196,
    });
    expect(audit!.issues).toEqual([
      { id: 2, severity: 'error', count: 1, delta: 0 },
      { id: 12, severity: 'warning', count: 5595, delta: 3 },
    ]);
  });
  it('returns null for an audit that has not finished a crawl', () => {
    expect(parseSiteAudit({ current_snapshot: null })).toBeNull();
  });
});

describe('parseTrackedPositions', () => {
  const mask = '*.example.com/*';
  it('reads date → mask nesting, and a 0 as not in the top 100', () => {
    const { rows, total } = parseTrackedPositions(
      {
        total: 2,
        data: {
          0: { Ph: 'mca loans', Nq: '1000', Dt: { '20260927': { [mask]: 4 }, '20260928': { [mask]: 0 } } },
          1: { Ph: 'business loans', Dt: { '20260928': { [mask]: 12 } }, Lu: { '20260928': { [mask]: 'https://example.com/b' } } },
        },
      },
      mask,
    );
    expect(total).toBe(2);
    expect(rows).toEqual([
      { keyword: 'mca loans', day: '2026-09-27', position: 4, url: null, searchVolume: 1000 },
      { keyword: 'mca loans', day: '2026-09-28', position: null, url: null, searchVolume: 1000 },
      { keyword: 'business loans', day: '2026-09-28', position: 12, url: 'https://example.com/b', searchVolume: null },
    ]);
  });
  it('reads mask → date nesting too', () => {
    const { rows } = parseTrackedPositions({ data: [{ Ph: 'k', Dt: { [mask]: { '20260928': 7 } } }] }, mask);
    expect(rows).toEqual([{ keyword: 'k', day: '2026-09-28', position: 7, url: null, searchVolume: null }]);
  });
});

describe('parseVisibility', () => {
  it('reads Vr, the percentage Semrush shows, from its real response', () => {
    // Campaign 29644497_4791801, 28 September 2026.
    expect(
      parseVisibility({
        total: '2',
        state: '1',
        data: {
          0: { Dt: '20260902', Vi: 1722200, Vr: 5.91415, Av: 84.4875 },
          1: { Dt: '20260901', Vi: 1720900, Vr: 5.90968, Av: 84.5125 },
        },
      }),
    ).toEqual([
      { day: '2026-09-01', visibility: 5.90968 },
      { day: '2026-09-02', visibility: 5.91415 },
    ]);
  });
});

describe('parseTrackedPositions against the real response', () => {
  it('reads "-" as not in the top 100 and an empty landing URL as none', () => {
    const mask = '*.spartancapitalgroup.com/*';
    const { rows, total } = parseTrackedPositions(
      {
        total: 80,
        state: '0',
        data: {
          0: {
            Ph: 'advantages of loans for seasonal businesses', Nq: '30',
            Dt: { '20260927': { [mask]: '-' }, '20260928': { [mask]: 9 } },
            Lu: { '20260927': { [mask]: '' }, '20260928': { [mask]: 'https://www.spartancapitalgroup.com/x' } },
          },
        },
      },
      mask,
    );
    expect(total).toBe(80);
    expect(rows).toEqual([
      { keyword: 'advantages of loans for seasonal businesses', day: '2026-09-27', position: null, url: null, searchVolume: 30 },
      { keyword: 'advantages of loans for seasonal businesses', day: '2026-09-28', position: 9, url: 'https://www.spartancapitalgroup.com/x', searchVolume: 30 },
    ]);
  });
});
