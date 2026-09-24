import type { NextRequest } from 'next/server';
import { noSpendReason, resolveDateRange, tenantDay, type AttributionModel } from '@zeeraa/core';
import { csvResponse, type CsvCell } from '@/lib/csv';
import { monthlyPerformance } from '@/lib/reporting';
import { requireTenant } from '@/lib/tenant';
import { coverageFor, isUnmeasured, notMeasuredReason, sourceName, sourcesThrough, throughNote } from '@/lib/coverage';

/**
 * CSV export, matching the filters on screen.
 *
 * It resolves the tenant through `requireTenant` and queries through
 * `queryTenant`, so the export is subject to the same row level security as the
 * page. There is no path here that reads a tenant the viewer does not belong
 * to, and no query that runs outside a tenant context.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenant: string; table: string }> },
): Promise<Response> {
  const { tenant: slug, table } = await params;
  const session = await requireTenant(slug);

  const search = request.nextUrl.searchParams;
  const model: AttributionModel =
    search.get('model') === 'first_touch' ? 'first_touch' : 'last_touch';
  /**
   * The same resolution the screens use, so an export matches the page it was
   * taken from — including a legacy `?days=` link somebody bookmarked.
   *
   * `earliest` is null here rather than queried: the only preset that needs it
   * is "All time", and the pages link to exports with explicit `from`/`to`
   * rather than a preset name.
   */
  const today = tenantDay(new Date(), session.tenant.timezone);
  const { range } = resolveDateRange({
    from: search.get('from'),
    to: search.get('to'),
    preset: search.get('preset'),
    days: search.get('days'),
    today,
    earliest: null,
  });

  if (table === 'performance' || table === 'funnel') {
    const [data, through] = await Promise.all([
      monthlyPerformance(session, range, model),
      sourcesThrough(session),
    ]);
    // The screen's rule, in the spreadsheet: a source not read for any of the
    // range exports empty cells and a note, never a column of zeros.
    const cover = coverageFor(through, range);
    const spendOut = isUnmeasured(cover.spend);
    const crmOut = isUnmeasured(cover.crm);
    const spendCell = <T,>(value: T): T | null => (spendOut ? null : value);
    const crmCell = <T,>(value: T): T | null => (crmOut ? null : value);
    const bothCell = <T,>(value: T): T | null => (spendOut || crmOut ? null : value);
    const stageHeaders = data.stages.map((s) => s.label);
    const valueLabel = data.stages.find((s) => s.countsValue)?.label ?? 'Funded';

    const stageCells = (counts: Record<string, number>): CsvCell[] =>
      data.stages.map((stage) =>
        // A blocked stage exports as an empty cell with the reason in the notes
        // column. Exporting a 0 would put a measurement in a spreadsheet that
        // the screen refuses to show.
        //
        // Raw numbers, not the display format: a thousands separator makes the
        // field a quoted string, and a spreadsheet will not sum a column of
        // those.
        crmOut || data.stageStatus[stage.key]?.blocked ? null : (counts[stage.key] ?? 0),
      );

    const rows: CsvCell[][] = [
      [
        'Row kind',
        'Channel',
        'Spend',
        'Impressions',
        'Clicks',
        'CTR',
        'CPC',
        ...stageHeaders,
        `${valueLabel} volume`,
        `Cost per ${valueLabel.toLowerCase()} deal`,
        'Attributed deals',
        'Cost per deal range low',
        'Cost per deal range high',
        'Notes',
      ],
      ...data.channels.map((channel): CsvCell[] =>
        channel.paid
          ? [
              'channel',
              channel.label,
              spendCell(channel.spend),
              spendCell(channel.impressions),
              spendCell(channel.clicks),
              spendCell(channel.ctr),
              spendCell(channel.cpc),
              ...stageCells(channel.stages),
              crmCell(channel.valueVolume),
              bothCell(channel.costPerDeal.value),
              crmCell(channel.costPerDeal.attributedDeals),
              bothCell(channel.costPerDeal.plausibleRange.low),
              bothCell(channel.costPerDeal.plausibleRange.high),
              '',
            ]
          : [
              // SEO/Organic or a lead vendor: counts and volume, and blanks —
              // not zeroes — where an ad channel has spend and costs.
              'source',
              channel.label,
              null,
              null,
              null,
              null,
              null,
              ...stageCells(channel.stages),
              crmCell(channel.valueVolume),
              null,
              crmCell(channel.costPerDeal.attributedDeals),
              null,
              null,
              noSpendReason(channel.platform),
            ],
      ),
      [
        'unattributed',
        data.unattributed.label,
        null,
        null,
        null,
        null,
        null,
        ...stageCells(data.unattributed.stages),
        crmCell(data.unattributed.valueVolume),
        null,
        null,
        null,
        null,
        data.unattributed.reason,
      ],
      [
        'total',
        data.total.label,
        spendCell(data.total.spend),
        spendCell(data.total.impressions),
        spendCell(data.total.clicks),
        spendCell(data.total.ctr),
        spendCell(data.total.cpc),
        ...stageCells(data.total.stages),
        crmCell(data.total.valueVolume),
        null,
        null,
        null,
        null,
        data.total.costPerDealAbsentBecause,
      ],
    ];

    const width = 6 + data.stages.length + 5;
    if (spendOut) {
      rows.push(['note', 'Spend is not measured', ...Array<CsvCell>(width).fill(null),
        notMeasuredReason(cover.spend, sourceName(through.spendPlatforms))]);
    }
    if (crmOut) {
      rows.push(['note', 'Stages are not measured', ...Array<CsvCell>(width).fill(null),
        notMeasuredReason(cover.crm, 'Salesforce')]);
    }
    // Partly read: the figures above are real but incomplete, and the
    // spreadsheet says which days are missing, as the screen does.
    if (!spendOut && cover.spend.state === 'partial') {
      rows.push(['note', 'Spend is incomplete', ...Array<CsvCell>(width).fill(null),
        throughNote(cover.spend, sourceName(through.spendPlatforms)).replace(/^ · /, '')]);
    }
    if (!crmOut && cover.crm.state === 'partial') {
      rows.push(['note', 'Stages are incomplete', ...Array<CsvCell>(width).fill(null),
        throughNote(cover.crm, 'Salesforce').replace(/^ · /, '')]);
    }

    for (const stage of data.stages) {
      const blocked = data.stageStatus[stage.key]?.blocked;
      if (blocked) {
        rows.push([
          'note',
          `${blocked.label} is not measured`,
          ...Array<CsvCell>(6 + data.stages.length + 5).fill(null),
          `${blocked.reason}${blocked.needed ? ` Needed: ${blocked.needed}` : ''}`,
        ]);
      }
    }

    return csvResponse(`${slug}-performance-${range.start}-to-${range.end}.csv`, rows);
  }

  return new Response(`Unknown table: ${table}`, { status: 404 });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
