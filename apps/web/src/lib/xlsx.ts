import { deflateRawSync } from 'node:zlib';

/**
 * A minimal Excel workbook writer (30 October 2026): one or more sheets of
 * typed cells, a bold frozen header row, and number formats for money,
 * percentages and dates. Nothing else — no formulas, no styles beyond those.
 *
 * Written here rather than taken from a library: the format is a zip of a few
 * XML parts, and the libraries that write it bring dozens of packages into a
 * deploy for a feature this small. Deflated: sheet XML is verbose, and a
 * Vercel function's response is capped at 4.5 MB — two months of calls was
 * 12 MB stored and is about a tenth of that compressed.
 *
 * Like the CSV export, a null is an empty cell and never a zero: a figure the
 * screen refuses to show does not become a measurement in a spreadsheet.
 */

export type XlsxCellType = 'text' | 'count' | 'number' | 'money' | 'percent' | 'date' | 'datetime' | 'boolean';
export type XlsxCell = string | number | boolean | Date | null;

export type XlsxColumn = { header: string; type: XlsxCellType; width?: number };

export type XlsxSheet = { name: string; columns: XlsxColumn[]; rows: XlsxCell[][] };

/** Style index per type, matching `STYLES` below: 0 plain, 1 bold header. */
const STYLE: Record<XlsxCellType, number> = {
  text: 0,
  count: 2,
  number: 3,
  money: 4,
  percent: 5,
  date: 6,
  datetime: 7,
  boolean: 0,
};

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/><numFmt numFmtId="166" formatCode="yyyy-mm-dd hh:mm"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `A`, `B`, … `Z`, `AA` for a zero-based column. */
function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** Excel's serial day number for a date: days since 1899-12-30, in UTC. */
function serial(value: Date): number {
  return value.getTime() / 86_400_000 + 25_569;
}

/** A `YYYY-MM-DD` day as a Date at UTC midnight, or the Date as is. */
function asDate(value: XlsxCell): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function cellXml(ref: string, value: XlsxCell, type: XlsxCellType): string {
  if (value === null || value === undefined || value === '') return '';
  const style = STYLE[type];
  if (type === 'date' || type === 'datetime') {
    const d = asDate(value);
    if (d) return `<c r="${ref}" s="${style}"><v>${serial(d)}</v></c>`;
  }
  if (type === 'boolean' || typeof value === 'boolean') {
    const text = value === true ? 'Yes' : value === false ? 'No' : String(value);
    return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`;
  }
  if (typeof value === 'number' && type !== 'text') {
    return Number.isFinite(value) ? `<c r="${ref}" s="${style}"><v>${value}</v></c>` : '';
  }
  const text = value instanceof Date ? value.toISOString() : String(value);
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet): string {
  const widths = sheet.columns
    .map((c, i) => {
      const longest = Math.max(
        c.header.length,
        ...sheet.rows.slice(0, 200).map((r) => (r[i] === null || r[i] === undefined ? 0 : String(r[i]).length)),
      );
      const width = c.width ?? Math.min(60, Math.max(10, longest + 2));
      return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
    })
    .join('');
  const header = `<row r="1">${sheet.columns
    .map((c, i) => `<c r="${columnName(i)}1" s="1" t="inlineStr"><is><t>${escapeXml(c.header)}</t></is></c>`)
    .join('')}</row>`;
  const body = sheet.rows
    .map(
      (row, r) =>
        `<row r="${r + 2}">${sheet.columns
          .map((c, i) => cellXml(`${columnName(i)}${r + 2}`, row[i] ?? null, c.type))
          .join('')}</row>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${widths}</cols><sheetData>${header}${body}</sheetData></worksheet>`
  );
}

/**
 * A sheet name Excel accepts: at most 31 characters, none of `[]:*?/\`, and
 * unique in the workbook.
 */
function sheetNames(sheets: XlsxSheet[]): string[] {
  const used = new Set<string>();
  return sheets.map((s) => {
    const base = (s.name.replace(/[[\]:*?/\\]/g, ' ').trim() || 'Sheet').slice(0, 31);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

export function workbook(sheets: XlsxSheet[]): Uint8Array {
  const list = sheets.length > 0 ? sheets : [{ name: 'Export', columns: [{ header: 'No rows', type: 'text' as const }], rows: [] }];
  const names = sheetNames(list);
  const files: [string, string][] = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        list
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        '</Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ],
    [
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        list
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('') +
        `<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    ],
    ['xl/styles.xml', STYLES],
    ...list.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return zipDeflated(files.map(([name, text]) => [name, new TextEncoder().encode(text)]));
}

/* ------------------------------------------------------------------------- */
/* A deflated zip                                                            */
/* ------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDeflated(files: [string, Uint8Array][]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, raw] of files) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(raw);
    const data = new Uint8Array(deflateRawSync(raw));
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 8, true); // deflated
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 8, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, raw.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
