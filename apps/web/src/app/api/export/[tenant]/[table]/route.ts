import type { NextRequest } from 'next/server';
import { tenantDay, trailingWindow, type AttributionModel } from '@zeeraa/core';
import { csvResponse, type CsvCell } from '@/lib/csv';
import { monthlyPerformance } from '@/lib/reporting';
import { deliveryStatus } from '@/lib/dashboard';
import { requireTenant } from '@/lib/tenant';

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
  const days = Number(search.get('days')) > 0 ? Math.min(Number(search.get('days')), 365) : 90;
  const today = tenantDay(new Date(), session.tenant.timezone);
  const range = trailingWindow(today, days);

  if (table === 'performance' || table === 'funnel') {
    const data = await monthlyPerformance(session, range, model);
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
        data.stageStatus[stage.key]?.blocked ? null : (counts[stage.key] ?? 0),
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
      ...data.channels.map((channel): CsvCell[] => [
        'channel',
        channel.label,
        channel.spend,
        channel.impressions,
        channel.clicks,
        channel.ctr,
        channel.cpc,
        ...stageCells(channel.stages),
        channel.valueVolume,
        channel.costPerDeal.value,
        channel.costPerDeal.attributedDeals,
        channel.costPerDeal.plausibleRange.low,
        channel.costPerDeal.plausibleRange.high,
        '',
      ]),
      [
        'unattributed',
        data.unattributed.label,
        null,
        null,
        null,
        null,
        null,
        ...stageCells(data.unattributed.stages),
        data.unattributed.valueVolume,
        null,
        null,
        null,
        null,
        data.unattributed.reason,
      ],
      [
        'total',
        data.total.label,
        data.total.spend,
        data.total.impressions,
        data.total.clicks,
        data.total.ctr,
        data.total.cpc,
        ...stageCells(data.total.stages),
        data.total.valueVolume,
        null,
        null,
        null,
        null,
        data.total.costPerDealAbsentBecause,
      ],
    ];

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

  if (table === 'delivery') {
    const delivery = await deliveryStatus(session, today);
    const rows: CsvCell[][] = [
      [
        'Commitment',
        'Committed',
        'Committed max',
        'Unit',
        'Period',
        'Delivered',
        'Source',
        'Awaiting approval',
        'Client approval required',
        'Notes',
      ],
      ...delivery.commitments.map((row): CsvCell[] => [
        row.label,
        row.committed,
        row.committedMax,
        row.unit,
        row.period,
        // Null, not zero: no record written for the period is not a delivery of
        // none, and the two must not be the same cell in a spreadsheet.
        row.delivered,
        row.source,
        row.awaitingApproval,
        row.requiresClientApproval ? 'yes' : 'no',
        row.delivered === null ? 'No delivery record written for this period' : '',
      ]),
      [],
      ['Service level', 'Commitment', 'Events recorded', 'Met', 'Compliance'],
      ...delivery.slas.map((row): CsvCell[] => [
        row.label,
        row.commitment,
        row.events,
        row.met,
        row.compliance,
      ]),
    ];
    return csvResponse(`${slug}-delivery-${delivery.periodStart}.csv`, rows);
  }

  return new Response(`Unknown table: ${table}`, { status: 404 });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
