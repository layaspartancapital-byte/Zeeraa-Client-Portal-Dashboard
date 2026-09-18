/**
 * A CSV reader, because this export needs a real one.
 *
 * Splitting on commas would be wrong here in a way that corrupts counts rather
 * than failing: Aloware's export carries `Body` and `Notes` columns holding
 * free text, so a field can contain a comma, a doubled quote, or a newline. A
 * naive split turns one call into several rows, or shifts every column right
 * for the rest of the file — and the result still parses, still imports, and is
 * silently wrong. The file has 29,229 lines and 28,863 calls for exactly this
 * reason.
 *
 * RFC 4180, with the two tolerances real exports need: CRLF or LF line endings,
 * and a trailing newline. Deliberately hand-written and tested rather than a
 * new dependency, for one vendor's export.
 */

/** Rows as objects keyed by the header row. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  const header = rows.shift();
  if (!header) return [];

  return rows.map((cells) => {
    const record: Record<string, string> = {};
    for (const [index, name] of header.entries()) {
      record[name] = cells[index] ?? '';
    }
    return record;
  });
}

/** The raw grid, for callers that want to see the header themselves. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  // A BOM in front of the first header name would make that column
  // unreachable by name, and Excel writes one.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endField = () => {
    row.push(field);
    field = '';
    started = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          // An escaped quote inside a quoted field.
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && !started) {
      quoted = true;
      started = true;
      continue;
    }
    if (char === ',') {
      endField();
      continue;
    }
    if (char === '\r') {
      // CRLF, or a lone CR from an older export.
      if (input[i + 1] === '\n') i += 1;
      endRow();
      continue;
    }
    if (char === '\n') {
      endRow();
      continue;
    }

    field += char;
    started = true;
  }

  // A final row with no trailing newline still counts; a trailing newline does
  // not produce an empty row.
  if (field !== '' || row.length > 0) endRow();

  return rows;
}
