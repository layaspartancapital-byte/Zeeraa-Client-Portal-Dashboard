import type { NextRequest } from 'next/server';
import { resolveDateRange, tenantDay, type AttributionModel } from '@zeeraa/core';
import { requireTenant } from '@/lib/tenant';
import {
  auditDetail,
  buildSheets,
  DATASETS,
  exportFileName,
  PAGES,
  pageExports,
  recordExport,
  seesContacts,
  type Dataset,
  type ExportPage,
  type ExportSpec,
} from '@/lib/exports';
import { workbook } from '@/lib/xlsx';

/**
 * The Excel exports (30 October 2026): one card's rows (`?dataset=`), or every
 * card on a page as one workbook (`?page=`), for the page's range, model and
 * source.
 *
 * The URL carries the filters and the export's name and nothing personal; the
 * file carries contact columns only for an admin, and the export is written
 * to the audit log — who, what, the range, the row count — before the file is
 * returned, so an export that could not be recorded is not served (and one
 * too large to serve is not recorded). Nothing here logs a row.
 */
const KEY = /^[A-Za-z0-9_:.-]{1,64}$/;
const MAX_BYTES = 4_300_000;

export async function GET(request: NextRequest, { params }: { params: Promise<{ tenant: string }> }): Promise<Response> {
  const { tenant: slug } = await params;
  const session = await requireTenant(slug);
  const search = request.nextUrl.searchParams;

  const text = (name: string) => {
    const v = search.get(name);
    return v && KEY.test(v) ? v : null;
  };
  const model: AttributionModel = search.get('model') === 'first_touch' ? 'first_touch' : 'last_touch';
  const today = tenantDay(new Date(), session.tenant.timezone);
  const { range } = resolveDateRange({
    from: search.get('from'),
    to: search.get('to'),
    preset: search.get('preset'),
    days: search.get('days'),
    today,
    earliest: null,
  });
  // Comparison's Period B, where the export is the Comparison page's.
  const bFrom = search.get('bFrom');
  const bTo = search.get('bTo');
  const compare =
    bFrom && bTo && /^\d{4}-\d{2}-\d{2}$/.test(bFrom) && /^\d{4}-\d{2}-\d{2}$/.test(bTo) && bFrom <= bTo
      ? { start: bFrom, end: bTo }
      : null;
  const filters = { range, model, source: text('source'), today, compare };
  const platform = text('platform');

  const page = text('page');
  const datasets = search
    .getAll('dataset')
    .filter((d) => KEY.test(d))
    .map((d) => {
      const [name, stage] = d.split(':');
      return { name: name!, stage: stage && /^[a-z_]{1,32}$/.test(stage) ? stage : undefined };
    })
    .filter((d) => (DATASETS as readonly string[]).includes(d.name));
  let specs: ExportSpec[];
  let what: string;
  if (page && (PAGES as readonly string[]).includes(page)) {
    const kind = platform === 'semrush' ? 'seo' : platform === 'ga4' || platform === 'search_console' ? 'organic' : 'paid';
    specs = pageExports(page as ExportPage, platform, kind);
    what = `page:${page}${platform ? `:${platform}` : ''}`;
  } else if (datasets.length > 0 && datasets.length <= 6) {
    specs = datasets.map((d) => ({ dataset: d.name as Dataset, stage: d.stage, platform: platform ?? undefined }));
    what = [datasets.map((d) => (d.stage ? `${d.name}:${d.stage}` : d.name)).join('+'), platform].filter(Boolean).join(':');
  } else {
    return new Response('Unknown export.', { status: 404 });
  }

  const contacts = seesContacts(session.tenant.role);
  const ctx = { session, filters, contacts };
  const sheets = (await Promise.all(specs.map((spec) => buildSheets(ctx, spec)))).flat();
  // A deals export carries its lender decisions; two on one page would repeat them.
  const seen = new Set<string>();
  const unique = sheets.filter((s) => {
    const key = `${s.name}|${s.rows.length}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const rows = unique.reduce((n, s) => n + s.rows.length, 0);

  const file = workbook(unique);
  // A Vercel function's response is capped at 4.5 MB. Past it the download
  // would fail with nothing said; this says what to do instead.
  if (file.length > MAX_BYTES) {
    return new Response('This export is too large for one file. Choose a shorter date range and export again.', {
      status: 413,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  await recordExport(session, auditDetail(what, filters, rows, contacts));

  // A fresh array over its own buffer, so the buffer is exactly the file.
  return new Response(file.buffer as ArrayBuffer, {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${exportFileName(slug, what.replace(/:/g, '-'), range)}"`,
      'cache-control': 'no-store',
    },
  });
}
