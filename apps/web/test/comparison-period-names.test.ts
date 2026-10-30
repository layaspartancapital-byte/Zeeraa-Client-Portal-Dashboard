import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Comparison never calls a period "A", "B", "Period A" or "Period B" — not
 * in a header, a card, a "based on" line, a legend, hover text or an export
 * (30 October 2026, client decision). A period is its name, from
 * `periodName` in core. This reads the sources and fails if a letter label
 * comes back as text a reader would see.
 */
const src = (path: string) => readFileSync(join(__dirname, '../src', path), 'utf8');

/** Text a reader sees: JSX text, and the contents of string and template literals. */
function visibleText(code: string): string[] {
  const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const jsx = [...withoutComments.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]!);
  const strings = [...withoutComments.matchAll(/'([^'\n]*)'|`([^`]*)`|"([^"\n]*)"/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
  return [...jsx, ...strings];
}

const LETTER = /\bPeriod [AB]\b|^\s*[AB]\s*$|\(\s*[AB]\s*\)|\b[AB] (on|target|based)\b|\b(Deals|Volume|Funded deals|Funded volume),? [AB]\b|\bA\s*[−-]\s*B\b|^[AB] \$\{/;

const FILES = [
  'components/ComparisonView.tsx',
  'components/ComparisonTable.tsx',
  'app/[tenant]/comparison/page.tsx',
  'lib/comparison.ts',
  'lib/comparison-rows.ts',
];

describe('Comparison names its periods', () => {
  it.each(FILES)('%s shows no letter label', (path) => {
    expect(visibleText(src(path)).filter((t) => LETTER.test(t))).toEqual([]);
  });

  it('exports name the periods too', () => {
    const code = src('lib/exports.ts');
    const comparison = code.slice(code.indexOf('async function comparisonSheets'), code.indexOf('export async function buildSheets'));
    expect(visibleText(comparison).filter((t) => LETTER.test(t))).toEqual([]);
    expect(comparison).toContain('report.names');
  });
});
