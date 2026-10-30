import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * "Export to Excel" on every card that shows leads, deals, calls, lenders,
 * campaigns, keywords, SEO or sources, and "Export everything" on every page
 * with such cards (30 October 2026). Reads the sources and fails if a page
 * loses its scope or a card its button. A new card of that kind belongs here.
 */
const src = (path: string) => readFileSync(join(__dirname, '../src', path), 'utf8');

const PAGES = [
  'app/[tenant]/page.tsx',
  'app/[tenant]/performance/page.tsx',
  'app/[tenant]/funnel/page.tsx',
  'app/[tenant]/platforms/[platform]/page.tsx',
];

const CARDS = [
  'components/AllFunded.tsx',
  'components/ContractTargetsCard.tsx',
  'components/ExecutiveRamp.tsx',
  'components/EfficiencyTable.tsx',
  'components/RampTable.tsx',
  'components/DeclineCard.tsx',
  'components/LenderOutcomes.tsx',
  'components/LenderOfferRateCard.tsx',
  'components/CallTracking.tsx',
  'components/KpiCard.tsx',
  'components/platform/FundedDealsCard.tsx',
  'components/platform/SeoPlatformView.tsx',
  'components/platform/OrganicPlatformView.tsx',
];

describe('Excel exports on every screen', () => {
  it.each(PAGES)('%s sets the export scope from its own range', (path) => {
    const code = src(path);
    expect(code).toMatch(/<ExportScope\s/);
    expect(code).toMatch(/from: range\.start,\s*to: range\.end/);
  });

  it.each([...PAGES, 'components/platform/SeoPlatformView.tsx', 'components/platform/OrganicPlatformView.tsx'])('%s offers Export everything where it draws its top bar', (path) => {
    const code = src(path);
    if (!code.includes('<TopBar')) return;
    expect(code).toContain('<ExportEverything />');
  });

  it.each(CARDS)('%s carries an Export to Excel button', (path) => {
    expect(src(path)).toMatch(/<ExportButton datasets=|exportAs=\{\[/);
  });

  it('the Comparison page exports both periods (30 October 2026)', () => {
    const code = src('app/[tenant]/comparison/page.tsx');
    expect(code).toContain('<ExportEverything />');
    expect(code).toMatch(/extra: \{ bFrom: b\.range\.start, bTo: b\.range\.end \}/);
    expect(src('components/ComparisonTable.tsx')).toContain("<ExportButton datasets={['comparison']} />");
    // Every card of the redesigned page (30 October 2026): the headline and
    // call cards, the funnel, costs, by source, and the folded table.
    const view = src('components/ComparisonView.tsx');
    expect(view.match(/<ExportButton datasets=\{\['comparison'\]\} \/>/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(view).toContain("<ExportButton datasets={['comparison_sources']} />");
    expect(src('lib/exports.ts')).toContain("return [{ dataset: 'comparison' }, { dataset: 'comparison_sources' }];");
  });

  it('decides contact columns on the server, by role, never from the URL', () => {
    const route = src('app/api/xlsx/[tenant]/route.ts');
    expect(route).toContain('seesContacts(session.tenant.role)');
    expect(route).not.toMatch(/searchParams\.get\('contacts'\)|get\('contacts'\)/);
    expect(src('lib/exports.ts')).toMatch(/role === 'zeeraa_admin' \|\| role === 'client_admin'/);
  });

  it('records every served export in the audit log', () => {
    const route = src('app/api/xlsx/[tenant]/route.ts');
    expect(route.indexOf('recordExport(')).toBeGreaterThan(0);
    expect(route.indexOf('recordExport(')).toBeLessThan(route.indexOf('return new Response(file.buffer'));
  });
});
