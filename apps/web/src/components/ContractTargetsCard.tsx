import { Card, CardHeader } from '@/components/ui/Card';
import { ExportButton } from '@/components/export/ExportScope';
import { SCORE_GRID, ScoreCell } from '@/components/ExecutiveRamp';
import type { ScorecardRow } from '@/lib/ramp-panels';

/**
 * "Zeeraa contract targets" (30 October 2026): the first thing on Executive,
 * and ringed so it reads as the thing the engagement is judged on — this
 * month against the signed contract.
 *
 * Cost per funded deal, cost per acquisition and funded volume against their
 * targets with the on-target / behind-pace verdict; funded deals and ad spend
 * beside them with none, because the contract sets none. Labels are plain;
 * how each figure is counted — every source, vendors out of volume, ad spend
 * only — is in its ⓘ. The ring is chrome ink: gold marks the active nav item
 * and nothing else.
 */
export function ContractTargetsCard({
  rows,
  heading,
  currency,
  partial,
}: {
  rows: ScorecardRow[];
  /** `Oct 2026 · month to date, 30 of 31 days · Zeeraa proposal, page 22`. */
  heading: string;
  currency: string;
  partial: boolean;
}) {
  return (
    <Card span={12} id="contract-targets" dataTour="contract-targets" className="ring-2 ring-primary">
      <CardHeader
        title="Zeeraa contract targets"
        subtitle={heading}
        controls={<ExportButton datasets={['ramp', 'deals:value']} />}
      />
      <dl className={SCORE_GRID}>
        {rows.map((row) => (
          <ScoreCell key={row.metric} row={row} channel="every source" currency={currency} partial={partial} />
        ))}
      </dl>
    </Card>
  );
}
