import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvRows } from '../src/aloware/csv';

describe('parseCsv', () => {
  it('keys each row by the header', () => {
    const rows = parseCsv('a,b\n1,2\n3,4\n');
    expect(rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('keeps a comma inside a quoted field', () => {
    // The `Body` and `Notes` columns are free text. A naive split shifts every
    // column right from here on, and the result still imports.
    const rows = parseCsv('Type,Body\ncall,"Called back, left message"\n');
    expect(rows[0]?.Body).toBe('Called back, left message');
    expect(rows[0]?.Type).toBe('call');
  });

  it('keeps a newline inside a quoted field as one row', () => {
    // This is why the file has 29,229 lines and 28,863 calls.
    const rows = parseCsv('id,Notes\n1,"line one\nline two"\n2,plain\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.Notes).toBe('line one\nline two');
    expect(rows[1]?.id).toBe('2');
  });

  it('unescapes a doubled quote', () => {
    const rows = parseCsv('id,Notes\n1,"he said ""no"" twice"\n');
    expect(rows[0]?.Notes).toBe('he said "no" twice');
  });

  it('reads CRLF as one row break', () => {
    const rows = parseCsv('a,b\r\n1,2\r\n');
    expect(rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('does not invent a row from a trailing newline', () => {
    expect(parseCsv('a\n1\n')).toHaveLength(1);
    expect(parseCsv('a\n1')).toHaveLength(1);
  });

  it('strips a byte-order mark so the first column is reachable by name', () => {
    // Excel writes one, and without this the first header name is "﻿a"
    // and every lookup of it returns undefined.
    const rows = parseCsv('﻿"Started At",Type\n2026-06-19,call\n');
    expect(rows[0]?.['Started At']).toBe('2026-06-19');
  });

  it('keeps an empty field empty rather than dropping the column', () => {
    const rows = parseCsv('a,b,c\n1,,3\n');
    expect(rows[0]).toEqual({ a: '1', b: '', c: '3' });
  });

  it('pads a short row instead of leaving keys undefined', () => {
    const rows = parseCsv('a,b,c\n1,2\n');
    expect(rows[0]).toEqual({ a: '1', b: '2', c: '' });
  });

  it('returns nothing for an empty file', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('parseCsvRows', () => {
  it('exposes the header as the first row', () => {
    expect(parseCsvRows('a,b\n1,2\n')[0]).toEqual(['a', 'b']);
  });

  it('treats a quote that is not at the start of a field as text', () => {
    // Aloware writes 6" in notes occasionally; it is not an opening quote.
    const rows = parseCsvRows('a\n5" pipe\n');
    expect(rows[1]).toEqual(['5" pipe']);
  });
});
