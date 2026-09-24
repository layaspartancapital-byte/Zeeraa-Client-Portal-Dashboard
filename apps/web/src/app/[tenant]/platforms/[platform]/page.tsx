import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/shell/AutoRefresh';
import { and, eq } from 'drizzle-orm';
import { schema } from '@zeeraa/db';
import {
  conversionRate,
  costPerConversion,
  cpc,
  cpm,
  ctr,
  formatCount,
  formatCurrency,
  formatRate,
  frequency,
  linkClickShare,
  tenantDay,
  rangeLengthDays,
  type AttributionModel,
} from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine, Grid } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { Segmented, segments } from '@/components/ui/Segmented';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { NotMeasuredCard } from '@/components/NotMeasuredCard';
import {
  coverageFor,
  isUnmeasured,
  notMeasuredReason,
  sourcesThrough,
  throughNote,
  dailyPoints,
} from '@/lib/coverage';
import { rangeLinks, rangeParams, resolvePageRange } from '@/lib/range';
import { MethodDrawer, MethodNotesForPrint, type MethodNote } from '@/components/ui/Drawer';
import { PageMeta, TopBar } from '@/components/shell/TopBar';
import { PrintButton } from '@/components/shell/actions';
import { AreaSeries } from '@/components/charts/AreaSeries';
import { CostPerDealFigure } from '@/components/CostPerDeal';
import { platformView } from '@/lib/platform';
import { organicView } from '@/lib/organic';
import { OrganicPlatformView } from '@/components/platform/OrganicPlatformView';
import { reportingPlatforms } from '@/lib/platforms';
import { campaignTypeLabel, VOCABULARY } from '@/lib/platform-labels';
import { platformLabel } from '@/lib/reporting';
import { queryTenant, requireTenant } from '@/lib/tenant';
import { loadMetrics } from '@/lib/dashboard';



const SERIES = [
  { key: 'spend', label: 'Spend' },
  { key: 'impressions', label: 'Impressions' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'conversions', label: 'Conversions' },
];

/** Offered only where the platform reports it. Meta does; Google does not. */
const REACH_SERIES = { key: 'reach', label: 'Reach' };

/** Each organic source's own series, in its own words. */
const ORGANIC_SERIES: Record<string, { key: string; label: string }[]> = {
  ga4: [
    { key: 'primary', label: 'Sessions' },
    { key: 'tertiary', label: 'Users' },
    { key: 'secondary', label: 'Engaged sessions' },
  ],
  search_console: [
    { key: 'primary', label: 'Clicks' },
    { key: 'secondary', label: 'Impressions' },
  ],
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ platform: string }>;
}) {
  const { platform } = await params;
  return { title: platformLabel(platform) };
}

/**
 * One ad platform, as that platform reports itself.
 *
 * Everything above "What became of it" came from the platform's own API and is
 * true of the platform's own measurement. Google counts a conversion the way
 * this account's tags are configured; Meta counts a lead the way this pixel
 * fires; neither has any idea whether a deal was funded. The outcomes block is
 * Salesforce, says so, and is separated by a full-width rule so the two are
 * never read as one table.
 *
 * Nothing on this page is computed for a platform that does not report it.
 * Reach and the link-click distinction appear on Meta and are absent from
 * Google — absent, not zero, and not borrowed.
 */
export default async function PlatformPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string; platform: string }>;
  searchParams: Promise<{
    from?: string;
    to?: string;
    preset?: string;
    /** Read only so a link made before the date picker existed still works. */
    days?: string;
    model?: string;
    series?: string;
  }>;
}) {
  const { tenant: slug, platform } = await params;
  const query = await searchParams;
  const session = await requireTenant(slug);

  // Exactly the rule the rail uses, from the same function, so a page can never
  // exist without an entry or an entry without a page. A platform this client
  // has never run is a 404 rather than an empty screen implying the connector
  // exists and is quiet.
  const reporting = await reportingPlatforms(session);
  const entry = reporting.find((p) => p.key === platform);
  if (!entry) notFound();

  const { range, preset, problem, today, earliest } = await resolvePageRange(session, query);
  const days = rangeLengthDays(range);

  // No zeros for a range past a source's last read — see `lib/coverage.ts`.
  // This platform's own figures ask this platform; the outcomes ask Salesforce.
  const cover = coverageFor(await sourcesThrough(session), range);
  const metrics = await loadMetrics(session);
  const own = cover.of(platform);
  const ownOut = isUnmeasured(own);
  const cutoff = entry.kind === 'organic' ? 'published' : 'synced';
  const ownWhy = notMeasuredReason(own, entry.label, cutoff);
  const ownNote = throughNote(own, entry.label, cutoff);

  /*
   * Organic sources take a different page, not the same page with the numbers
   * swapped: no spend, no campaigns, and no outcomes section, because neither
   * GA4 nor Search Console can be attributed to a deal. One route so the rail
   * and the URLs stay uniform; two views because the content genuinely differs.
   */
  if (entry.kind === 'organic') {
    const seriesOptions = ORGANIC_SERIES[platform] ?? ORGANIC_SERIES.ga4!;
    const seriesKey = seriesOptions.some((s) => s.key === query.series)
      ? query.series!
      : 'primary';
    // The organic branch returns before the paid-media controls are built, so
    // it resolves its own links. Same range, different companion params.
    const organicLinks = rangeLinks(`/${slug}/platforms/${platform}`, { series: seriesKey });
    const view = await organicView(
      session,
      platform as 'ga4' | 'search_console',
      entry.label,
      range,
    );
    return (
      <OrganicPlatformView
        session={session}
        view={view}
        slug={slug}
        rangeControl={
          <DateRangePicker
            range={range}
            preset={preset}
            presetHref={organicLinks.presetHref}
            preserve={organicLinks.preserve}
            problem={problem}
            earliest={earliest}
            today={today}
          />
        }
        rangeParams={rangeParams(range)}
        seriesKey={seriesKey}
        seriesOptions={seriesOptions}
        notMeasured={ownOut ? ownWhy : undefined}
        coverageNote={ownNote}
        dailySeries={dailyPoints(range, own, view.daily, (d) =>
          seriesKey === 'secondary' ? d.secondary : seriesKey === 'tertiary' ? d.tertiary : d.primary,
        )}
      />
    );
  }

  const crmOut = isUnmeasured(cover.crm);
  const outcomesOut = crmOut || ownOut;
  const outcomesWhy = crmOut ? notMeasuredReason(cover.crm, 'Salesforce') : ownWhy;

  const model: AttributionModel = query.model === 'first_touch' ? 'first_touch' : 'last_touch';
  const requestedSeries = query.series ?? 'spend';
  const currency = session.tenant.currency;

  const [valueStage] = await queryTenant(session, (tx) =>
    tx
      .select({ key: schema.funnelStages.key, label: schema.funnelStages.label })
      .from(schema.funnelStages)
      .where(
        and(
          eq(schema.funnelStages.tenantId, session.tenant.id),
          eq(schema.funnelStages.countsValue, true),
        ),
      )
      .limit(1),
  );

  const view = await platformView(
    session,
    platform,
    platformLabel(platform),
    range,
    valueStage ?? null,
    model,
  );

  const t = view.totals;
  const vocabulary = VOCABULARY[platform];
  const reportsReach = view.daily.some((d) => d.reach !== null);
  const reportsLinkDistinction = t.allClicks !== null;
  // Reach is a real figure per day even though it cannot be totalled, so it
  // belongs in the series on the platform that reports it and nowhere else.
  const seriesOptions = reportsReach ? [...SERIES, REACH_SERIES] : SERIES;
  const seriesKey = seriesOptions.some((s) => s.key === requestedSeries) ? requestedSeries : 'spend';
  const stageWord = (view.outcomes.stageLabel ?? 'funded').toLowerCase();

  const base = `/${slug}/platforms/${platform}`;
  const { preserve, presetHref } = rangeLinks(base, { model, series: seriesKey });
  const active = { ...rangeParams(range), model, series: seriesKey };

  const notes: MethodNote[] = [
    {
      heading: 'Where these figures come from',
      body:
        `Every figure above the outcomes block is ${view.label}'s own reporting, pulled from ` +
        'its API and stored as reported. None of it passes through Salesforce.',
      detail:
        'Rates are arithmetic over two reported figures — CTR is clicks over impressions, CPM is ' +
        'spend per thousand impressions — and a rate with an empty denominator is rendered as an ' +
        'absence rather than as zero. A day with spend and no impressions did not achieve a CPM ' +
        'of zero; there was no auction to price.',
    },
    {
      heading: 'Conversions are the platform’s, not the CRM’s',
      body:
        `A conversion here is what ${view.label} counted, on whatever the account is configured ` +
        'to fire on. It is not a funded deal and the two should never be divided into each other.',
    },
    ...(reportsLinkDistinction
      ? [
          {
            heading: 'Clicks and link clicks',
            body:
              'Meta counts every click on an ad — reactions, comments, profile taps — as well as ' +
              'clicks that go somewhere. The Clicks figure here is link clicks, which is what ' +
              'Google Ads’ own click figure means, so the two platforms can sit in one table.',
            detail:
              `Over this window: ${formatCount(t.clicks)} link clicks of ${formatCount(t.allClicks!)} ` +
              'total clicks.',
          },
        ]
      : []),
    ...(reportsReach
      ? [
          {
            heading: 'Why there is no total reach',
            body:
              'Reach counts people, and Meta deduplicates them across whatever range it is asked ' +
              'for. Adding daily reach counts somebody who saw an ad on two days twice, so this ' +
              'page does not add it.',
            detail:
              'The daily figures are shown as reported. A deduplicated figure for the whole ' +
              'window is a separate query against Meta and is not derived from these rows.',
          },
        ]
      : []),
    {
      heading: `What became of it`,
      body:
        `Funded deals come from Salesforce, attributed to ${view.label} by the click identifier ` +
        'carried from the lead. Both halves of the cost per deal come from this channel.',
      detail:
        view.outcomes.campaignAttributionBlocked ??
        'Deals no channel can claim are counted separately and never enter this denominator.',
    },
  ];

  return (
    <>
      <TopBar tenant={session.tenant} viewer={session.viewer} title={view.label}>
        <DateRangePicker
          range={range}
          preset={preset}
          presetHref={presetHref}
          preserve={preserve}
          problem={problem}
          earliest={earliest}
          today={today}
        />
        <PrintButton />
      </TopBar>

      <PageMeta>
        <span className="flex flex-wrap items-center gap-2 text-[12px] text-text-3">
          {/* Neutral when healthy: green means improvement, never a status. */}
          <Badge tone={view.connection?.status === 'healthy' ? 'neutral' : 'warn'}>
            {view.connection?.status ?? 'not connected'}
          </Badge>
          <span className="tabular">
            account {view.connection?.accountIdentifier ?? '—'} ·{' '}
            {view.daysReported} of {days} days reported
          </span>
          <AutoRefresh />
        </span>
        <MethodDrawer notes={notes} title={`${view.label} · ${range.start} to ${range.end}`} />
      </PageMeta>

      <Grid>
        {/* ---------------- platform-reported ---------------- */}
        {ownOut ? (
          <NotMeasuredCard
            title={`${view.label} reporting`}
            subtitle={`${range.start} to ${range.end}`}
            reason={ownWhy}
          />
        ) : (
        <>
        <Card span={12}>
          <CardHeader
            title={`${view.label} reporting`}
            subtitle={`${range.start} to ${range.end} · as ${view.label} reports it${ownNote}`}
            info={
              <InfoTip label="Where these figures come from" align="start">
                Every figure in this block is {view.label}&rsquo;s own, pulled from its API. None
                of it passes through Salesforce, and nothing here is computed for a platform that
                does not report it.
              </InfoTip>
            }
          />
          <CardBody>
            <dl className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
              <Figure label="Spend" value={formatCurrency(t.spend, currency)} />
              <Figure label="Impressions" value={formatCount(t.impressions)} />
              <Figure
                label="Clicks"
                value={formatCount(t.clicks)}
                note={reportsLinkDistinction ? 'link clicks' : undefined}
              />
              <Figure label="CTR" value={rate(ctr(t.clicks, t.impressions))} />
              <Figure label="CPC" value={money(cpc(t.spend, t.clicks), currency)} />
              <Figure label="CPM" value={money(cpm(t.spend, t.impressions), currency)} />
              <Figure label="Conversions" value={formatCount(Math.round(t.conversions))} />
              <Figure
                label="Conversion rate"
                value={rate(conversionRate(t.conversions, t.clicks))}
              />
              <Figure
                label="Cost per conversion"
                value={money(costPerConversion(t.spend, t.conversions), currency)}
              />

              {/* Meta only. Absent on Google because Google does not report it. */}
              {reportsLinkDistinction && (
                <Figure
                  label="All clicks"
                  value={formatCount(t.allClicks!)}
                  note={`${rate(linkClickShare(t.clicks, t.allClicks))} went somewhere`}
                  info="Every click Meta counts, including reactions, comments and profile taps. Google Ads reports one click figure and makes no such distinction, so this figure does not exist on that page."
                />
              )}
              {reportsReach && (
                <Figure
                  label="Reach"
                  notMeasured="Not summable"
                  info="Reach counts people and Meta deduplicates them across whatever range it is asked for, so daily figures cannot be added. The per-day values are in the series and the campaign table below."
                />
              )}
            </dl>
          </CardBody>
        </Card>

        {/* ---------------- time series ---------------- */}
        <Card span={12}>
          <CardHeader
            title="Over time"
            subtitle={`By day, as reported · ${view.daysReported} days with data`}
            controls={
              // Five options do not fit a 390px card, so the control scrolls
              // inside its own container rather than being clipped by the card
              // edge — and `min-w-0` is what stops it widening the page instead.
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
                  id={`platform-${platform}-${seriesKey}`}
                  points={dailyPoints(range, own, view.daily, (d) => seriesValue(d, seriesKey))}
                  format={
                    seriesKey === 'spend' ? { kind: 'currency', currency } : { kind: 'count' }
                  }
                  height={240}
                />
              </div>
            )}
          </CardBody>
        </Card>

        {/* ---------------- by campaign type ---------------- */}
        <Card span={12}>
          <CardHeader
            title={`By ${vocabulary?.typeColumnLabel.toLowerCase() ?? 'campaign type'}`}
            subtitle={`${view.label}'s own classification · not comparable across platforms`}
            info={
              <InfoTip label="Why this is not a shared breakdown" align="start">
                This is {view.label}&rsquo;s own word for what a campaign is. Google&rsquo;s
                advertising channel type and Meta&rsquo;s objective answer different questions, so
                neither page groups its values with the other&rsquo;s.
              </InfoTip>
            }
          />
          <div className="scroll-x min-w-0 overflow-x-auto border-t border-border">
            <table className="w-full min-w-[720px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-[12px] font-semibold text-text-2">
                  <th scope="col" className="px-5 py-2.5">{vocabulary?.typeColumnLabel ?? 'Type'}</th>
                  <th scope="col" className="numeric px-3 py-2.5">
                    <span className="inline-flex items-center gap-1.5">
                      Campaigns
                      <InfoTip label="What the campaign counts mean" align="center">
                        Delivering in this window, of those the account holds. A type with
                        campaigns and no delivery is shown as zero rather than left out, because
                        silence and &ldquo;we do not run it&rdquo; are different answers.
                      </InfoTip>
                    </span>
                  </th>
                  <th scope="col" className="numeric px-3 py-2.5">Spend</th>
                  <th scope="col" className="numeric px-3 py-2.5">Impressions</th>
                  <th scope="col" className="numeric px-3 py-2.5">Clicks</th>
                  <th scope="col" className="numeric px-3 py-2.5">CTR</th>
                  <th scope="col" className="numeric px-3 py-2.5">CPC</th>
                  <th scope="col" className="numeric px-3 py-2.5">CPM</th>
                  <th scope="col" className="numeric px-5 py-2.5">Conversions</th>
                </tr>
              </thead>
              <tbody>
                {view.byCampaignType.map((row) => (
                  <tr
                  key={row.key ?? 'none'}
                  className={`border-b border-border last:border-b-0 ${
                    row.delivering === 0 ? 'text-text-3' : ''
                  }`}
                >
                    <th scope="row" className="px-5 py-3 text-left font-medium text-text">
                      {campaignTypeLabel(platform, row.key)}
                    </th>
                    <td className="numeric px-3 py-3 tabular text-text-2">
                      {formatCount(row.delivering)}
                      <span className="text-text-3"> of {formatCount(row.configured)}</span>
                    </td>
                    <td className="numeric px-3 py-3 tabular text-text">{formatCurrency(row.spend, currency)}</td>
                    <td className="numeric px-3 py-3 tabular text-text-2">{formatCount(row.impressions)}</td>
                    <td className="numeric px-3 py-3 tabular text-text-2">{formatCount(row.clicks)}</td>
                    <td className="numeric px-3 py-3 tabular text-text-2">{rate(ctr(row.clicks, row.impressions))}</td>
                    <td className="numeric px-3 py-3 tabular text-text-2">{money(cpc(row.spend, row.clicks), currency)}</td>
                    <td className="numeric px-3 py-3 tabular text-text-2">{money(cpm(row.spend, row.impressions), currency)}</td>
                    <td className="numeric px-5 py-3 tabular text-text-2">{formatCount(Math.round(row.conversions))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {view.byCampaignType.length === 0 && (
            <CardBody>
              <EmptyLine>No campaign has reported in this window.</EmptyLine>
            </CardBody>
          )}
        </Card>

        {/* ---------------- per campaign ---------------- */}
        <Card span={12}>
          <CardHeader
            title="Campaigns"
            subtitle={`${formatCount(view.byCampaign.length)} with delivery in this window`}
          />
          <div className="scroll-x min-w-0 overflow-x-auto border-t border-border">
            <table className="w-full min-w-[900px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-[12px] font-semibold text-text-2">
                  <th scope="col" className="px-5 py-2.5">Campaign</th>
                  <th scope="col" className="px-3 py-2.5">{vocabulary?.typeColumnLabel ?? 'Type'}</th>
                  <th scope="col" className="numeric px-3 py-2.5">Spend</th>
                  <th scope="col" className="numeric px-3 py-2.5">Impressions</th>
                  <th scope="col" className="numeric px-3 py-2.5">Clicks</th>
                  <th scope="col" className="numeric px-3 py-2.5">CTR</th>
                  <th scope="col" className="numeric px-3 py-2.5">CPC</th>
                  <th scope="col" className="numeric px-3 py-2.5">Conv.</th>
                  <th scope="col" className="numeric px-5 py-2.5">Cost / conv.</th>
                </tr>
              </thead>
              <tbody>
                {view.byCampaign.map((row) => (
                  <tr key={row.externalCampaignId} className="border-b border-border last:border-b-0">
                    <th scope="row" className="max-w-[320px] px-5 py-3 text-left font-medium text-text">
                      <span className="block truncate" title={row.name}>{row.name}</span>
                      {row.status && (
                        <span className="text-[12px] font-normal text-text-3">{row.status}</span>
                      )}
                    </th>
                    <td className="px-3 py-3 text-text-2">{campaignTypeLabel(platform, row.campaignType)}</td>
                    <td className="numeric px-3 py-3 tabular text-text">{formatCurrency(row.spend, currency)}</td>
                    <td className="numeric px-3 py-3 tabular text-text-2">{formatCount(row.impressions)}</td>
                    <td className="numeric px-3 py-3 tabular text-text-2">{formatCount(row.clicks)}</td>
                    <td className="numeric px-3 py-3 tabular text-text-2">{rate(ctr(row.clicks, row.impressions))}</td>
                    <td className="numeric px-3 py-3 tabular text-text-2">{money(cpc(row.spend, row.clicks), currency)}</td>
                    <td className="numeric px-3 py-3 tabular text-text-2">{formatCount(Math.round(row.conversions))}</td>
                    <td className="numeric px-5 py-3 tabular text-text-2">{money(costPerConversion(row.spend, row.conversions), currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {view.byCampaign.length === 0 && (
            <CardBody>
              <EmptyLine>No campaign has reported in this window.</EmptyLine>
            </CardBody>
          )}
        </Card>

        </>
        )}

        {/* ================= outcomes, from the CRM ================= */}
        <div className="col-span-12 mt-2 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-[12px] font-semibold uppercase tracking-wide text-text-3">
            What became of it · from Salesforce
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>

        {outcomesOut ? (
          <NotMeasuredCard title={`Cost per ${stageWord} deal`} reason={outcomesWhy} />
        ) : (
        <>
        <Card span={8}>
          <CardHeader
            title={`Cost per ${stageWord} deal`}
            subtitle={`Salesforce · deals attributed to ${view.label}`}
            controls={<Badge tone="neutral">CRM, not {view.label}</Badge>}
          />
          <CardBody>
            <CostPerDealFigure
              cost={view.outcomes.cost}
              currency={currency}
              channelLabel={view.label}
              size="hero"
            />
            <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 border-t border-border pt-4 sm:grid-cols-4">
              <Figure
                label={`${view.outcomes.stageLabel ?? 'Funded'} deals attributed`}
                value={formatCount(view.outcomes.cost.attributedDeals)}
              />
              <Figure
                label="Share of all deals in period"
                value={
                  view.outcomes.dealsInPeriod === 0
                    ? '—'
                    : `${formatCount(view.outcomes.cost.attributedDeals)} of ${formatCount(view.outcomes.dealsInPeriod)}`
                }
                note={
                  view.outcomes.dealsInPeriod === 0
                    ? undefined
                    : formatRate(view.outcomes.cost.attributedDeals / view.outcomes.dealsInPeriod)
                }
                info="Every connected channel's page shows its own share, and they do not add up to 100% — deals no channel can claim belong to none of them. That remainder is the honest gap, not a rounding error."
              />
              <Figure
                label="Attributed elsewhere"
                value={formatCount(view.outcomes.cost.dealsAttributedElsewhere)}
                info="Deals in this period that another connected channel can claim. They are not in this channel's denominator."
              />
              <Figure
                label="No channel can claim"
                value={formatCount(view.outcomes.cost.unattributedDeals)}
                info="Deals carrying no click from any connected channel. They are in nobody's denominator, and the range on the figure above is where it would land if every one of them turned out to be this channel's."
              />
            </dl>
          </CardBody>
        </Card>

        <Card span={4}>
          <CardHeader
            title="By campaign"
            subtitle={`Which ${view.label} campaign produced the deal`}
          />
          <CardBody>
            {view.outcomes.campaignAttributionBlocked ? (
              <div className="flex flex-col gap-2">
                <Badge tone="warn" className="self-start">
                  Not measurable
                </Badge>
                <p className="text-[13px] leading-snug text-text-2">
                  {view.outcomes.campaignAttributionBlocked}
                </p>
              </div>
            ) : view.outcomes.byCampaign.length === 0 ? (
              <EmptyLine>
                No {stageWord} deal in this window resolves to a campaign.
              </EmptyLine>
            ) : (
              <ul className="divide-y divide-border">
                {view.outcomes.byCampaign.map((row) => (
                  <li key={row.campaignId} className="flex items-center gap-3 py-2.5">
                    <span className="min-w-0 flex-1 truncate text-[13px] text-text">
                      {row.name ?? row.campaignId}
                    </span>
                    <span className="shrink-0 text-[13px] font-semibold tabular text-text">
                      {formatCount(row.deals)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {!view.outcomes.campaignAttributionBlocked && (
              <p className="mt-3 border-t border-border pt-2 text-[12px] text-text-3 tabular">
                {formatCount(view.outcomes.dealsResolvingToCampaign)} of{' '}
                {formatCount(view.outcomes.cost.attributedDeals)} attributed deals resolve to a
                campaign
              </p>
            )}
          </CardBody>
        </Card>
        </>
        )}
      </Grid>

      <MethodNotesForPrint notes={notes} />
    </>
  );
}

function seriesValue(
  day: { spend: number; impressions: number; clicks: number; conversions: number; reach: number | null },
  key: string,
): number | null {
  switch (key) {
    case 'impressions':
      return day.impressions;
    case 'clicks':
      return day.clicks;
    case 'conversions':
      return day.conversions;
    // Null on a day the platform reported nothing, which the chart leaves blank
    // rather than plotting as zero people reached.
    case 'reach':
      return day.reach;
    default:
      return day.spend;
  }
}

/** A rate the platform's numbers support, or an explicit absence. */
function rate(value: number | null): string {
  return value === null ? '—' : formatRate(value);
}

function money(value: number | null, currency: string): string {
  return value === null ? '—' : formatCurrency(value, currency);
}

/**
 * One reported figure.
 *
 * `notMeasured` renders the amber badge instead of a value — for a figure the
 * platform reports at a grain this page refuses to total, which is not the same
 * as a figure it does not report at all. A figure a platform does not report is
 * simply not rendered.
 */
function Figure({
  label,
  value,
  note,
  info,
  notMeasured,
}: {
  label: string;
  value?: string;
  note?: string;
  info?: string;
  notMeasured?: string;
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
      <dd className="mt-0.5 text-[20px] font-semibold tabular leading-tight text-text">
        {notMeasured ? <Badge tone="warn">{notMeasured}</Badge> : value}
      </dd>
      {note && <dd className="text-[12px] text-text-3">{note}</dd>}
    </div>
  );
}
