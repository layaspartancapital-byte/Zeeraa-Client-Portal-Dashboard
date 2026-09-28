import type { ReactNode } from 'react';
import { AutoRefresh } from '@/components/shell/AutoRefresh';
import { NotMeasuredCard } from '@/components/NotMeasuredCard';
import { formatCount, intentLabels, positionMove, type ImprovementDirection } from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine, Grid } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Delta } from '@/components/ui/Delta';
import { InfoTip } from '@/components/ui/InfoTip';
import { MethodDrawer, MethodNotesForPrint, type MethodNote } from '@/components/ui/Drawer';
import { PageMeta, TopBar } from '@/components/shell/TopBar';
import { PrintButton } from '@/components/shell/actions';
import { AreaSeries } from '@/components/charts/AreaSeries';
import { MiniChart } from '@/components/charts/MiniChart';
import type { SeoDomainChanges, SeoView } from '@/lib/seo';

type SeoFormula = keyof SeoView['directions'];
import type { TenantSession } from '@/lib/tenant';

/**
 * SEO, from Semrush.
 *
 * The snapshots (keywords, AI Overviews, backlinks, the site audit) are each
 * as of the day Semrush was read and are compared with the month or crawl
 * before. Position Tracking is by day and follows the date range. The two are
 * never on one card, because one follows the range and the other does not.
 */
export function SeoPlatformView({
  session,
  view,
  label,
  range,
  rangeControl,
  trackingNotMeasured,
  trackingNote = '',
  showOperational,
}: {
  session: TenantSession;
  view: SeoView;
  label: string;
  range: { start: string; end: string };
  rangeControl: ReactNode;
  /** Why Position Tracking has nothing for the range, from `notMeasuredReason`. */
  trackingNotMeasured?: string;
  /** "· Semrush synced through …" where the range runs past the last read. */
  trackingNote?: string;
  /** Zeeraa staff: the unit spend and the blocked states a client does not see. */
  showOperational: boolean;
}) {
  const { current, previous, backlinks, backlinksPrevious, audit, tracking } = view;
  // Declared in core (`improvementDirectionFor`), carried on the view.
  const siteHealth: ImprovementDirection | null = view.directions.site_health;
  const compared = previous ? `vs ${monthLabel(previous.month)}` : undefined;
  const monthPoints = <K extends keyof NonNullable<typeof current>>(key: K) =>
    view.months.map((m) => ({ label: monthLabel(m.month), value: m[key] as number }));

  const notes: MethodNote[] = [
    {
      heading: 'Where these figures come from',
      body: 'Every figure on this page is Semrush’s, read from its API for the US database. Keywords, traffic and backlinks are Semrush’s snapshot of the domain on the day it was read.',
      detail: 'Past months are Semrush’s own monthly figures; the month in progress is the latest read. Position Tracking is Semrush checking each tracked keyword every day.',
    },
    {
      heading: 'Estimated traffic is a model, not a measurement',
      body: 'Semrush estimates visits from rankings and search volumes. Search Console and GA4 measure them; use those for how many people came.',
    },
    {
      heading: 'AI Overviews',
      body: 'Google’s AI Overview only. Semrush reports which of the domain’s ranking keywords show an AI Overview, and in which of those the domain is cited as a source.',
      detail: 'ChatGPT, Gemini and Perplexity are not measured: Semrush offers no API for them.',
    },
    {
      heading: 'New and lost referring domains',
      body: 'A domain is new on the day Semrush first saw a link from it, and lost on the day it last saw one. Each list is read monthly, newest first, up to 100 domains.',
    },
  ];

  return (
    <>
      <TopBar tenant={session.tenant} viewer={session.viewer} title={label}>
        {rangeControl}
        <PrintButton />
      </TopBar>

      <PageMeta>
        <span className="flex flex-wrap items-center gap-2 text-[12px] text-text-3">
          <Badge tone={view.connection?.status === 'healthy' ? 'neutral' : 'warn'}>
            {view.connection?.status ?? 'not connected'}
          </Badge>
          <span className="truncate tabular">
            Semrush · {view.connection?.domain ?? '—'} · {(view.connection?.database ?? 'us').toUpperCase()}
            {current ? ` · read ${dayLabel(current.readOn)}` : ''}
          </span>
          {showOperational && (
            <span className="tabular">
              · {formatCount(view.units.trailingYear)} of {formatCount(view.units.budget)} units this year
            </span>
          )}
          <AutoRefresh />
        </span>
        <MethodDrawer notes={notes} title={`${label} · Semrush`} />
      </PageMeta>

      <Grid>
        {current ? (
          <>
            <Kpi
              title="Organic keywords"
              value={formatCount(current.organicKeywords)}
              sub={`Ranking in Google’s top 100 · as of ${dayLabel(current.readOn)}`}
              current={current.organicKeywords}
              baseline={previous?.organicKeywords ?? null}
              formula="organic_keywords"
              directions={view.directions}
              comparison={compared}
              points={monthPoints('organicKeywords')}
            />
            <Kpi
              title="On page one"
              value={formatCount(current.positions1to3 + current.positions4to10)}
              sub={`${formatCount(current.positions1to3)} in the top 3 · ${formatCount(current.positions11to20)} on page two`}
              current={current.positions1to3 + current.positions4to10}
              baseline={previous ? previous.positions1to3 + previous.positions4to10 : null}
              formula="organic_keywords"
              directions={view.directions}
              comparison={compared}
              points={view.months.map((m) => ({ label: monthLabel(m.month), value: m.positions1to3 + m.positions4to10 }))}
            />
            <Kpi
              title="Estimated organic traffic"
              info="Semrush’s estimate of monthly visits from its rankings, not a measurement. Search Console has the measured clicks."
              value={formatCount(current.organicTraffic)}
              sub="Visits a month, estimated"
              current={current.organicTraffic}
              baseline={previous?.organicTraffic ?? null}
              formula="estimated_organic_traffic"
              directions={view.directions}
              comparison={compared}
              points={monthPoints('organicTraffic')}
            />
            <Kpi
              title="AI Overview citations"
              info="Links to this domain inside Google’s AI Overviews: one per keyword and cited page, so a keyword citing two pages counts twice. Google only."
              value={formatCount(current.aiOverviewCited)}
              sub={`${view.aiOverview.readOn ? `Across ${formatCount(view.aiOverview.rows.length)} keywords · ` : ''}${formatCount(current.aiOverviewKeywords)} ranking keywords show an AI Overview`}
              current={current.aiOverviewCited}
              baseline={previous?.aiOverviewCited ?? null}
              formula="ai_overview_citations"
              directions={view.directions}
              comparison={compared}
              points={monthPoints('aiOverviewCited')}
            />
            {backlinks && (
              <>
                <Kpi
                  title="Referring domains"
                  value={formatCount(backlinks.referringDomains)}
                  sub={`${formatCount(backlinks.backlinks)} backlinks${
                    backlinks.followBacklinks !== null ? ` · ${formatCount(backlinks.followBacklinks)} followed` : ''
                  }`}
                  current={backlinks.referringDomains}
                  baseline={backlinksPrevious?.referringDomains ?? null}
                  formula="referring_domains"
                  directions={view.directions}
                  comparison={backlinksPrevious ? `vs ${monthLabel(backlinksPrevious.month)}` : undefined}
                  points={view.backlinkMonths.map((b) => ({ label: monthLabel(b.month), value: b.referringDomains }))}
                />
                <Kpi
                  title="Authority Score"
                  info="Semrush’s 0–100 score for the strength of the domain’s backlink profile."
                  value={String(backlinks.authorityScore)}
                  sub="Out of 100"
                  current={backlinks.authorityScore}
                  baseline={backlinksPrevious?.authorityScore ?? null}
                  formula="authority_score"
                  directions={view.directions}
                  comparison={backlinksPrevious ? `vs ${monthLabel(backlinksPrevious.month)}` : undefined}
                  points={view.backlinkMonths.map((b) => ({ label: monthLabel(b.month), value: b.authorityScore }))}
                />
              </>
            )}
          </>
        ) : (
          <NotMeasuredCard title="Search visibility" reason="Semrush has not been read for this client yet." />
        )}

        {/* Position Tracking follows the range. Hidden from a client until a
            campaign exists; Zeeraa staff see why it is empty. */}
        {view.trackingConfigured && trackingNotMeasured ? (
          <NotMeasuredCard
            title="Tracked keywords"
            subtitle={`${range.start} to ${range.end}`}
            reason={trackingNotMeasured}
          />
        ) : tracking ? (
          <TrackingCard tracking={tracking} directions={view.directions} range={range} note={trackingNote} />
        ) : (
          showOperational && (
            <NotMeasuredCard
              title="Tracked keywords"
              reason={
                view.trackingConfigured
                  ? 'Semrush Position Tracking has reported nothing for this campaign yet.'
                  : 'No Semrush Position Tracking campaign is recorded on the connection.'
              }
            />
          )
        )}

        <Card span={12}>
          <CardHeader
            title="Top organic keywords"
            subtitle={
              view.topKeywords.readOn
                ? `By share of estimated traffic · top ${formatCount(view.topKeywords.rows.length)} of ${formatCount(view.topKeywords.read)} read ${dayLabel(view.topKeywords.readOn)}`
                : undefined
            }
          />
          {view.topKeywords.rows.length === 0 ? (
            <CardBody>
              <EmptyLine>No keywords have been read yet.</EmptyLine>
            </CardBody>
          ) : (
            <Table
              minWidth={760}
              head={['Keyword', 'Position', 'Change', 'Volume', 'Traffic share', 'Difficulty', 'URL']}
              rows={view.topKeywords.rows.map((k) => [
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
              ])}
            />
          )}
        </Card>

        <Card span={6}>
          <CardHeader
            title="Keywords cited in AI Overviews"
            subtitle={
              view.aiOverview.readOn
                ? `${formatCount(view.aiOverview.rows.length)} keywords · read ${dayLabel(view.aiOverview.readOn)}`
                : undefined
            }
            info={
              <InfoTip label="About AI Overview citations" align="start">
                Keywords where Google’s AI Overview links to this domain. Other AI assistants are not measured.
              </InfoTip>
            }
          />
          {view.aiOverview.rows.length === 0 ? (
            <CardBody>
              <EmptyLine>No AI Overview citations were read.</EmptyLine>
            </CardBody>
          ) : (
            <Table
              minWidth={420}
              head={['Keyword', 'Volume', 'URL']}
              rows={view.aiOverview.rows.map((k) => [
                <span key="k" className="truncate" title={k.keyword}>{k.keyword}</span>,
                formatCount(k.searchVolume),
                <UrlCell key="u" url={k.url} />,
              ])}
            />
          )}
        </Card>

        <Card span={6}>
          <CardHeader
            title="Organic competitors"
            subtitle={view.competitors.readOn ? `By Semrush’s relevance · read ${dayLabel(view.competitors.readOn)}` : undefined}
            info={
              <InfoTip label="About competitors" align="start">
                Domains ranking for the same keywords, ordered by how many they share relative to their size.
              </InfoTip>
            }
          />
          {view.competitors.rows.length === 0 ? (
            <CardBody>
              <EmptyLine>No competitors have been read yet.</EmptyLine>
            </CardBody>
          ) : (
            <Table
              minWidth={420}
              head={['Domain', 'Shared keywords', 'Keywords', 'Est. traffic']}
              rows={view.competitors.rows.map((c) => [
                <span key="d" className="truncate" title={c.domain}>{c.domain}</span>,
                formatCount(c.commonKeywords),
                formatCount(c.organicKeywords),
                formatCount(c.organicTraffic),
              ])}
            />
          )}
        </Card>

        <DomainChangesCard title="New referring domains" changes={view.newDomains} range={range} verb="first seen" />
        <DomainChangesCard title="Lost referring domains" changes={view.lostDomains} range={range} verb="last seen" />

        {audit ? (
          <Card span={12}>
            <CardHeader
              title="Site audit"
              subtitle={`Semrush crawl of ${formatCount(audit.pagesCrawled)} pages · finished ${dayLabel(audit.finishedOn)}`}
            />
            <CardBody>
              <dl className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-5">
                <div className="min-w-0">
                  <dt className="flex items-center gap-1 text-[12px] font-medium text-text-3">
                    Site Health
                    <InfoTip label="About Site Health" align="start">
                      Semrush’s 0–100 score: the share of its checks the crawled pages passed, weighted by severity.
                    </InfoTip>
                  </dt>
                  <dd className="mt-0.5 text-[20px] font-semibold tabular leading-tight text-text">{audit.healthScore}</dd>
                  <dd>
                    <Delta
                      current={audit.healthScore}
                      baseline={view.auditPrevious?.healthScore ?? null}
                      direction={siteHealth}
                      comparison={view.auditPrevious ? `vs crawl of ${dayLabel(view.auditPrevious.finishedOn)}` : undefined}
                      unavailable="first crawl read"
                    />
                  </dd>
                </div>
                <Stat label="Errors" value={formatCount(audit.errors)} />
                <Stat label="Warnings" value={formatCount(audit.warnings)} />
                <Stat label="Notices" value={formatCount(audit.notices)} />
                {audit.aiSearchScore !== null && (
                  <Stat
                    label="AI search readiness"
                    value={String(audit.aiSearchScore)}
                    info="Semrush’s 0–100 score for whether AI crawlers can reach and read the pages."
                  />
                )}
              </dl>
              {Object.keys(audit.thematicScores).length > 0 && (
                <ul className="mt-4 flex flex-wrap gap-2 text-[12px] text-text-2">
                  {Object.entries(audit.thematicScores).map(([name, score]) => (
                    <li key={name} className="rounded-md border border-border px-2 py-1 tabular">
                      {THEMES[name] ?? name} <span className="font-semibold text-text">{score}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
            {audit.issues.length > 0 && (
              <Table
                minWidth={520}
                head={['Issue', 'Severity', 'Found', 'Change']}
                rows={audit.issues.slice(0, 15).map((i) => [
                  <span key="t" className="truncate" title={i.title}>{i.title}</span>,
                  i.severity === 'error' ? 'Error' : i.severity === 'warning' ? 'Warning' : 'Notice',
                  formatCount(i.count),
                  i.delta === 0 ? '—' : `${i.delta > 0 ? '+' : '−'}${formatCount(Math.abs(i.delta))}`,
                ])}
              />
            )}
          </Card>
        ) : (
          showOperational && <NotMeasuredCard title="Site audit" reason="No Semrush site audit has been read yet." />
        )}
      </Grid>

      <MethodNotesForPrint notes={notes} />
    </>
  );
}

const THEMES: Record<string, string> = {
  crawlability: 'Crawlability',
  https: 'HTTPS',
  intSeo: 'International SEO',
  performance: 'Performance',
  linking: 'Internal linking',
  markups: 'Markup',
};

function Kpi({
  title,
  info,
  value,
  sub,
  current,
  baseline,
  formula,
  directions,
  comparison,
  points,
}: {
  title: string;
  info?: string;
  value: string;
  sub: string;
  current: number;
  baseline: number | null;
  /** The formula whose direction colours the change, from `improvementDirectionFor` in core. */
  formula: SeoFormula;
  directions: SeoView['directions'];
  comparison?: string;
  points: { label: string; value: number | null }[];
}) {
  const direction: ImprovementDirection | null = directions[formula];
  return (
    <Card span={4}>
      <CardHeader
        title={title}
        info={
          info ? (
            <InfoTip label={`About ${title}`} align="start">
              {info}
            </InfoTip>
          ) : undefined
        }
      />
      <CardBody>
        <p className="text-[26px] font-semibold tabular leading-tight text-text">{value}</p>
        <p className="mt-0.5 text-[12px] text-text-3">{sub}</p>
        <Delta
          className="mt-1.5"
          current={current}
          baseline={baseline}
          direction={direction}
          comparison={comparison}
          unavailable="no earlier month read"
        />
        <div className="mt-3">
          <MiniChart points={points} label={`${title} by month`} />
        </div>
      </CardBody>
    </Card>
  );
}

function TrackingCard({
  tracking,
  directions,
  range,
  note,
}: {
  tracking: NonNullable<SeoView['tracking']>;
  directions: SeoView['directions'];
  range: { start: string; end: string };
  note: string;
}) {
  const top10: ImprovementDirection | null = directions.tracked_top_10;
  const end = tracking.bandsEnd;
  const start = tracking.bandsStart;
  const since = tracking.firstDay && tracking.firstDay !== tracking.lastDay ? `vs ${dayLabel(tracking.firstDay)}` : undefined;
  return (
    <Card span={12}>
      <CardHeader
        title="Tracked keywords"
        subtitle={`${range.start} to ${range.end} · Semrush Position Tracking${
          tracking.lastDay ? `, positions on ${dayLabel(tracking.lastDay)}` : ''
        }${note}`}
      />
      <CardBody>
        {end && (
          <dl className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
            <Stat label="Tracked" value={formatCount(end.tracked)} />
            <div className="min-w-0">
              <dt className="text-[12px] font-medium text-text-3">In the top 10</dt>
              <dd className="mt-0.5 text-[20px] font-semibold tabular leading-tight text-text">{formatCount(end.top10)}</dd>
              {start && since && (
                <dd>
                  <Delta current={end.top10} baseline={start.top10} direction={top10} comparison={since} />
                </dd>
              )}
            </div>
            <Stat label="In the top 3" value={formatCount(end.top3)} />
            <Stat label="Not in the top 100" value={formatCount(end.notRanking)} />
          </dl>
        )}
      </CardBody>
      {tracking.visibility.length > 0 && (
        <div className="px-2 pb-3">
          <AreaSeries
            id="seo-visibility"
            points={tracking.visibility.map((v) => ({ label: v.day.slice(5), value: v.value }))}
            format={{ kind: 'percentPoints' }}
            height={200}
          />
        </div>
      )}
      {tracking.keywords.length > 0 && (
        <Table
          minWidth={560}
          head={['Keyword', 'Volume', tracking.firstDay ? dayLabel(tracking.firstDay) : 'Start', tracking.lastDay ? dayLabel(tracking.lastDay) : 'End', 'Change']}
          rows={tracking.keywords.slice(0, 100).map((k) => [
            <span key="k" className="truncate" title={k.keyword}>{k.keyword}</span>,
            k.searchVolume === null ? '—' : formatCount(k.searchVolume),
            k.start === null ? 'Not in top 100' : String(k.start),
            k.end === null ? 'Not in top 100' : String(k.end),
            <PositionChange key="c" before={k.start} after={k.end} />,
          ])}
        />
      )}
    </Card>
  );
}

function DomainChangesCard({
  title,
  changes,
  range,
  verb,
}: {
  title: string;
  changes: SeoDomainChanges;
  range: { start: string; end: string };
  verb: string;
}) {
  // The read is capped; before its oldest entry the list cannot say it is complete.
  const partial = changes.completeFrom !== null && changes.completeFrom > range.start;
  return (
    <Card span={6}>
      <CardHeader
        title={title}
        subtitle={`${range.start} to ${range.end} · ${formatCount(changes.inRange)}${partial ? '+' : ''} domains${
          partial ? ` (complete from ${dayLabel(changes.completeFrom!)})` : ''
        }`}
      />
      {changes.rows.length === 0 ? (
        <CardBody>
          <EmptyLine>{changes.readOn ? `None ${verb} in this range.` : 'Not read yet.'}</EmptyLine>
        </CardBody>
      ) : (
        <Table
          minWidth={380}
          head={['Domain', 'Authority', 'Links', verb[0]!.toUpperCase() + verb.slice(1)]}
          rows={changes.rows.map((d) => [
            <span key="d" className="truncate" title={d.domain}>{d.domain}</span>,
            String(d.authorityScore),
            formatCount(d.backlinks),
            dayLabel(d.on),
          ])}
        />
      )}
    </Card>
  );
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

function UrlCell({ url }: { url: string }) {
  const path = url.replace(/^https?:\/\/[^/]+/, '') || '/';
  return (
    <span className="block max-w-[220px] truncate text-text-2" title={url}>
      {path}
    </span>
  );
}

function Stat({ label, value, info }: { label: string; value: string; info?: string }) {
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
    </div>
  );
}

function Table({ head, rows, minWidth }: { head: string[]; rows: ReactNode[][]; minWidth: number }) {
  return (
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
          {rows.map((cells, r) => (
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
          ))}
        </tbody>
      </table>
    </div>
  );
}

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const DAY = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function monthLabel(month: string): string {
  return MONTH.format(new Date(`${month.slice(0, 7)}-01T00:00:00Z`));
}

function dayLabel(day: string): string {
  return DAY.format(new Date(`${day}T00:00:00Z`));
}
