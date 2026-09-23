import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No zeros for a range past a source's last read.
 *
 * A range after Salesforce's last sync rendered every CRM figure as 0 — a
 * measurement claiming nothing happened. The rule lives in `lib/coverage.ts`;
 * this reads the sources of every screen that draws synced figures, and of the
 * export, and fails if one stops asking it. A new screen that draws stage
 * counts or spend belongs in this list.
 */
const src = (path: string) => readFileSync(join(__dirname, '../src', path), 'utf8');

const SCREENS = [
  'app/[tenant]/page.tsx',
  'app/[tenant]/performance/page.tsx',
  'app/[tenant]/funnel/page.tsx',
  'app/[tenant]/platforms/[platform]/page.tsx',
  'app/api/export/[tenant]/[table]/route.ts',
];

describe('every screen asks how far its sources have been read', () => {
  it.each(SCREENS)('%s applies coverage and names the unmeasured state', (path) => {
    const code = src(path);
    expect(code).toContain('sourcesThrough(session)');
    expect(code).toContain('isUnmeasured(');
    expect(code).toContain('notMeasuredReason(');
  });

  it('marks a bucket past the last read as not ingested, for every chart', () => {
    const code = src('lib/dashboard.ts');
    expect(code).toMatch(/spendIngested:[\s\S]{0,160}span\.start <= spendThrough/);
    expect(code).toMatch(/crmIngested:[\s\S]{0,160}span\.start <= crmThrough/);
  });
});
