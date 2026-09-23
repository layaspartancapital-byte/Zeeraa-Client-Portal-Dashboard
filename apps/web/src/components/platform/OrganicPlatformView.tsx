import type { ReactNode } from 'react';
import { NotMeasuredCard } from '@/components/NotMeasuredCard';
import { formatCount, formatRate, ctr } from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine, Grid } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { Segmented, segments } from '@/components/ui/Segmented';
import { MethodDrawer, MethodNotesForPrint, type MethodNote } from '@/components/ui/Drawer';
import { PageMeta, TopBar } from '@/components/shell/TopBar';
import { PrintButton } from '@/components/shell/actions';
import { AreaSeries } from '@/components/charts/AreaSeries';
import { DIMENSION_LABELS, type OrganicView } from '@/lib/organic';
import type { TenantSession } from '@/lib/tenant';

/**
 * GA4 and Search Console.
 *
 * Deliberately **not** the ad-platform page with the numbers swapped. There is
 * no spend, no campaign and — the part that matters — no outcomes section,
 * because neither source can be attributed to a deal. That absence is stated on
 * the page as its own card rather than left as a hole a reader has to notice:
 * a missing dependency is an explicit blocked state, not a silent gap.
 */
export function OrganicPlatformView({
  session,
  view,
  slug,
  rangeControl,
  rangeParams,
  seriesKey,
  seriesOptions,
  notMeasured,
  coverageNote = '',
  dailySeries,
}: {
  /**
   * Why nothing in the range can be shown: the source has published nothing
   * for any of it. Replaces every figure on the page rather than drawing a
   * collapse in traffic. From `notMeasuredReason` in `lib/coverage.ts`.
   */
  notMeasured?: string;
  /** "· GA4 synced through …" where the range runs past what is published. */
  coverageNote?: string;
  /**
   * The daily chart's points with unread days as gaps, from `dailyPoints`.
   * Without it the chart would join straight across a day nobody read.
   */
  dailySeries?: { label: string; value: number | null }[];
  session: TenantSession;
  view: OrganicView;
  slug: string;
  /** The page's date picker, rendered by the page that resolved the range. */
  rangeControl: ReactNode;
  /** The resolved range as params, so the series toggle keeps the period. */
  rangeParams: Record<string, string>;
  seriesKey: string;
  seriesOptions: { key: string; label: string }[];
}) {
  const isGa4 = view.kind === 'ga4';
  const base = `/${slug}/platforms/${view.kind}`;
  const active = { ...rangeParams, series: seriesKey };
  const g = view.ga4;
  const s = view.searchConsole;

  const notes: MethodNote[] = [
    {
      heading: 'Where these figures come from',
      body: `Everything on this page is ${view.label}'s own reporting, pulled from its API and stored as reported.`,
      detail: isGa4
        ? 'GA4 reprocesses for roughly 48 hours, so the most recent days move after the fact. The whole window is re-pulled and upserted on every run rather than appended from a watermark.'
        : 'Search Console finalises over two to three days, so this window deliberately ends short of today — asking for days it has not finalised returns nothing, which draws as a collapse in traffic rather than as an absence.',
    },
    {
      heading: 'Why the breakdowns do not match the total',
      body: isGa4
        ? 'The daily total is authoritative; each breakdown is the top rows the API returned. They are not the same population, and each table states how its figure compares.'
        : 'Search Console’s grouped and ungrouped totals disagree in both directions, and neither is an error. Grouping by query omits searches issued by very few people, for privacy, so it sums well below the total. Grouping by page can sum slightly above it, because a click is attributed per canonical URL.',
      detail: isGa4
        ? 'GA4 also reports its own placeholders — (not set), (direct) / (none), (data not available) — and they are shown as themselves rather than cleaned away, because they are facts about how the property is configured.'
        : 'Over Spartan’s trailing window, queries account for about 57% of clicks and pages for about 102%. Reconciling them is not possible and not the point: the daily total is the figure to quote, and each breakdown is a view of it.',
    },
    ...(isGa4
      ? []
      : [
          {
            heading: 'Average position is impression-weighted',
            body:
              'A plain average of daily positions weights a day with three impressions like a day with three thousand, and would disagree with the Search Console UI.',
          },
        ]),
    {
      heading: 'Why there are no funded deals on this page',
      body: attributionNote(view.kind),
    },
  ];

  return (
    <>
      <TopBar tenant={session.tenant} viewer={session.viewer} title={view.label}>
        {rangeControl}
        <PrintButton />
      </TopBar>

      <PageMeta>
        <span className="flex flex-wrap items-center gap-2 text-[12px] text-text-3">
          <Badge tone={view.connection?.status === 'healthy' ? 'up' : 'warn'}>
            {view.connection?.status ?? 'not connected'}
          </Badge>
          <span className="truncate tabular">
            {view.connection?.accountIdentifier ?? '—'} · {view.daysReported} days reported
            {view.lastDayWithData ? ` · through ${view.lastDayWithData}` : ''}
          </span>
        </span>
        <MethodDrawer notes={notes} title={`${view.label} · ${view.range.start} to ${view.range.end}`} />
      </PageMeta>

      <Grid>
        {notMeasured ? (
          <NotMeasuredCard
            title={`${view.label} reporting`}
            subtitle={`${view.range.start} to ${view.range.end}`}
            reason={notMeasured}
          />
        ) : (
        <>
        <Card span={12}>
          <CardHeader
            title={`${view.label} reporting`}
            subtitle={`${view.range.start} to ${view.range.end} · as ${view.label} reports it${coverageNote}`}
          />
          <CardBody>
            <dl className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
              {isGa4 && g && (
                <>
                  <Figure label="Sessions" value={formatCount(g.sessions)} />
                  <Figure label="Users" value={formatCount(g.users)} />
                  <Figure label="Engaged sessions" value={formatCount(g.engagedSessions)} />
                  <Figure
                    label="Engagement rate"
                    value={
                      g.sessions > 0 ? formatRate(g.engagedSessions / g.sessions) : '—'
                    }
                    info="Engaged sessions over sessions, as GA4 defines an engaged session: longer than ten seconds, or with a conversion, or with two or more page views."
                  />
                </>
              )}
              {!isGa4 && s && (
                <>
                  <Figure label="Clicks" value={formatCount(s.clicks)} />
                  <Figure label="Impressions" value={formatCount(s.impressions)} />
                  <Figure
                    label="CTR"
                    value={(() => {
                      const rate = ctr(s.clicks, s.impressions);
                      return rate === null ? '—' : formatRate(rate);
                    })()}
                    info="Clicks over impressions, derived at read time. It is never stored, because a stored ratio is one sum away from nonsense."
                  />
                  <Figure
                    label="Average position"
                    value={s.position === null ? '—' : s.position.toFixed(1)}
                    note="impression-weighted"
                    info="Weighted by impressions, as Search Console weights its own. A plain average of daily positions would weight a day with three impressions like a day with three thousand."
                  />
                </>
              )}
            </dl>
          </CardBody>
        </Card>

        <Card span={12}>
          <CardHeader
            title="Over time"
            subtitle={`By day, as reported · ${view.daysReported} days with data`}
            controls={
              <span className="scroll-x -mx-1 min-w-0 max-w-full overflow-x-auto px-1">
                <Segmented
                  label="Series"
                  active={seriesKey}
                  options={segments(base, active, 'series', seriesOptions)}
                />
              </span>
            }
          />
          <CardBody flush>
            {view.daily.length === 0 ? (
              <CardBody>
                <EmptyLine>Nothing has been ingested for this window.</EmptyLine>
              </CardBody>
            ) : (
              <div className="px-2 pb-3">
                <AreaSeries
                  id={`organic-${view.kind}-${seriesKey}`}
                  points={
                    dailySeries ??
                    view.daily.map((d) => ({ label: d.date.slice(5), value: seriesValue(d, seriesKey) }))
                  }
                  format={{ kind: 'count' }}
                  height={240}
                />
              </div>
            )}
          </CardBody>
        </Card>

        {view.breakdowns.map((breakdown) => (
          <Card key={breakdown.dimension} span={6}>
            <CardHeader
              title={DIMENSION_LABELS[breakdown.dimension] ?? breakdown.dimension}
              subtitle={`Top ${formatCount(breakdown.rows.length)} of ${formatCount(breakdown.distinctValues)} in this window`}
              info={
                <InfoTip label="How this compares with the total" align="start">
                  {ratioNote(view.kind, breakdown.dimension)}
                </InfoTip>
              }
              controls={
                <span className="flex items-center gap-2">
                  {breakdown.capped && (
                    <Badge tone="neutral">
                      Tail cut
                      <InfoTip label="Why the tail is missing" align="center">
                        The API returned its maximum number of rows for this window, so values
                        below the cut-off are not stored. The daily totals above are unaffected.
                      </InfoTip>
                    </Badge>
                  )}
                  {breakdown.ratioToTotal !== null && (
                    <span
                      className={`text-[12px] tabular ${
                        breakdown.ratioToTotal > 1 ? 'text-[#B54708]' : 'text-text-3'
                      }`}
                    >
                      {formatRate(breakdown.ratioToTotal)} of the {isGa4 ? 'session' : 'click'}{' '}
                      total
                    </span>
                  )}
                </span>
              }
            />
            <div className="scroll-x min-w-0 overflow-x-auto border-t border-border">
              <table className="w-full min-w-[420px] border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left text-[12px] font-semibold text-text-2">
                    <th scope="col" className="px-5 py-2.5">
                      {DIMENSION_LABELS[breakdown.dimension] ?? breakdown.dimension}
                    </th>
                    <th scope="col" className="numeric px-3 py-2.5">{isGa4 ? 'Sessions' : 'Clicks'}</th>
                    <th scope="col" className="numeric px-3 py-2.5">{isGa4 ? 'Users' : 'Impr.'}</th>
                    <th scope="col" className="numeric px-5 py-2.5">{isGa4 ? 'Engaged' : 'Position'}</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.rows.map((row) => (
                    <tr key={row.value} className="border-b border-border last:border-b-0">
                      <th scope="row" className="max-w-[260px] px-5 py-2.5 text-left font-medium text-text">
                        <span className="block truncate" title={row.value}>
                          {row.value === '' ? <span className="text-text-3">(empty)</span> : row.value}
                        </span>
                      </th>
                      <td className="numeric px-3 py-2.5 tabular text-text">{formatCount(row.primary)}</td>
                      <td className="numeric px-3 py-2.5 tabular text-text-2">
                        {formatCount(isGa4 ? row.tertiary : row.secondary)}
                      </td>
                      <td className="numeric px-5 py-2.5 tabular text-text-2">
                        {isGa4
                          ? formatCount(row.secondary)
                          : row.position === null
                            ? '—'
                            : row.position.toFixed(1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {breakdown.rows.length === 0 && (
              <CardBody>
                <EmptyLine>Nothing was reported for this dimension.</EmptyLine>
              </CardBody>
            )}
          </Card>
        ))}

        </>
        )}

        {/* The absence, stated. Every ad platform page ends with funded deals;
            this one cannot, and saying why is the point. */}
        <Card span={12}>
          <CardHeader
            title="Funded deals"
            subtitle="Not attributable from this source"
            controls={<Badge tone="warn">Not measurable</Badge>}
          />
          <CardBody>
            <p className="max-w-3xl text-[13px] leading-snug text-text-2">
              {attributionNote(view.kind)}
            </p>
          </CardBody>
        </Card>
      </Grid>

      <MethodNotesForPrint notes={notes} />
    </>
  );
}

/**
 * Why neither source reaches a deal. Stated in each source's own terms, because
 * the reasons are different and a shared sentence would blur them.
 */
const ATTRIBUTION_NOTE: Record<OrganicView['kind'], string> = {
  ga4:
    'The GA4 Data API exposes no identifier for a person or a session — there is no clientId ' +
    'dimension and no sessionId dimension — so a session can never be joined to the lead it ' +
    'became. This is the shape of the API rather than a gap in ingestion, and no amount of ' +
    'further syncing changes it. Closing it needs website work: a custom dimension carrying an ' +
    'identifier the CRM also stores, or the BigQuery export. Salesforce does hold a ' +
    'Session_ID__c on about 72% of web-originated leads, but its values are UUIDs and GA4’s own ' +
    'identifiers are digit-shaped, so it is the form vendor’s handle and not a GA4 key.',
  search_console:
    'Search Console reports what a query did and what a page did, and never who did it. There ' +
    'is no identifier of any kind in its data, so there is nothing that could be joined to a ' +
    'lead even in principle. Organic search shows up in the funnel as unattributed demand, ' +
    'which is where it honestly belongs.',
};

/** Why a breakdown's figure differs from the total, in that source's terms. */
function ratioNote(kind: OrganicView['kind'], dimension: string): string {
  if (kind === 'ga4') {
    return (
      'The daily total above is authoritative and these are the top rows the API returned. The ' +
      'two need not match: GA4 counts a session once for the day and again for each dimension ' +
      'value it touched, so a breakdown can land slightly either side of the total. Treat this ' +
      'as how closely the two agree, not as a share.'
    );
  }
  if (dimension === 'query') {
    return (
      'Search Console omits searches issued by very few people, for privacy, so grouping by ' +
      'query sums well below the day’s total. Those clicks are in the total and in no row here, ' +
      'permanently.'
    );
  }
  return (
    'Grouping by page can exceed the ungrouped total, because a click is attributed per ' +
    'canonical URL and Search Console counts the two differently. Above 100% is the API ' +
    'behaving as documented, not a double count here.'
  );
}

function attributionNote(kind: OrganicView['kind']): string {
  return ATTRIBUTION_NOTE[kind];
}

function seriesValue(day: { primary: number; secondary: number; tertiary: number }, key: string): number {
  switch (key) {
    case 'secondary':
      return day.secondary;
    case 'tertiary':
      return day.tertiary;
    default:
      return day.primary;
  }
}

function Figure({
  label,
  value,
  note,
  info,
}: {
  label: string;
  value: string;
  note?: string;
  info?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-[12px] font-medium text-text-3">
        <span className="truncate">{label}</span>
        {info && (
          <InfoTip label={`About ${label}`} align="center">
            {info}
          </InfoTip>
        )}
      </dt>
      <dd className="mt-0.5 text-[20px] font-semibold tabular leading-tight text-text">{value}</dd>
      {note && <dd className="text-[12px] text-text-3">{note}</dd>}
    </div>
  );
}
