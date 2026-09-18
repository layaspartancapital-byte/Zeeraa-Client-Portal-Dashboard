/**
 * CSV, per §12's export requirement: every table exports, matching the active
 * filters.
 *
 * The filters match because the export route reads the same search params the
 * page did and calls the same query functions — there is no second definition
 * of "the current view" to drift out of step.
 */
export type CsvCell = string | number | null;

/**
 * RFC 4180 quoting. A field is quoted when it holds a comma, a quote, a newline
 * or leading/trailing space, and an embedded quote is doubled.
 *
 * A null is an empty field, deliberately and not a zero. The unattributed row
 * has no spend, and a 0 in that column of a spreadsheet is the same false claim
 * it would be on the screen — worse, because a spreadsheet will happily sum it.
 */
function field(value: CsvCell): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n\r]|^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows: readonly CsvCell[][]): string {
  // CRLF and a UTF-8 BOM: Excel opens the file as UTF-8 only with the BOM, and
  // a client opening the export in Excel is the whole point of it existing.
  return `﻿${rows.map((row) => row.map(field).join(',')).join('\r\n')}\r\n`;
}

export function csvResponse(filename: string, rows: readonly CsvCell[][]): Response {
  return new Response(toCsv(rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
