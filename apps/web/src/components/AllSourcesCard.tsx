import { formatCount, formatCurrency } from '@zeeraa/core';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { CostPerDealFigure } from '@/components/CostPerDeal';
import { platformLabel } from '@/lib/platform-labels';
import type { AllSources } from '@/lib/all-sources';
import type { ScorecardRow } from '@/lib/ramp-panels';
import { SCORE_GRID, ScoreCell } from '@/components/ExecutiveRamp';
import { ExportButton } from '@/components/export/ExportScope';

/**
 * Every source at once, beside the one channel the contract names: the
 * period's deals from everywhere, every ad platform's spend, and the
 * costs between them.
 *
 * Laid out as `RampScorecard` is. "All sources" is in every cost's label,
 * because a reader who takes one for a channel's cost per deal will credit the
 * ads with the sales team's month. Below, this calendar month against the
 * signed contract, whose targets are program-wide (30 October 2026): cost per
 * funded deal and cost per acquisition across every source, funded volume
 * across every source but lead vendors.
 */
export function AllSourcesCard({
  figures,
  valueLabel,
  periodLabel,
  currency,
  crmUnmeasured,
  spendUnmeasured,
  targets,
}: {
  figures: AllSources;
  valueLabel: string;
  /** The picked period in words, with any `throughNote`s. */
  periodLabel: string;
  currency: string;
  /** The reason, where Salesforce has not been read for the period. */
  crmUnmeasured?: string;
  /** The reason, where the ad platforms have not been read for the period. */
  spendUnmeasured?: string;
  /** This calendar month against the contract (`contractRows`). */
  targets?: { rows: ScorecardRow[]; heading: string; currency: string; partial: boolean; source: string | null };
}) {
  const deal = valueLabel.toLowerCase();
  const platforms = figures.spendPlatforms.map(platformLabel);
  const named = platforms.length === 0 ? 'the ad platforms' : listed(platforms);
  const costUnmeasured = crmUnmeasured ?? spendUnmeasured;

  return (
    <Card span={12} id="all-sources">
      <CardHeader
        title="All sources"
        subtitle={periodLabel}
        controls={<ExportButton datasets={['sources', 'deals:value']} />}
      />
      <dl className={SCORE_GRID}>
        <Cell label={`Total ${deal} deals`} unmeasured={crmUnmeasured}>
          <Figure>{formatCount(figures.deals)}</Figure>
          <Sub>Every source, attributed or not</Sub>
        </Cell>

        <Cell label="Total ad spend" unmeasured={spendUnmeasured}>
          <Figure>{formatCurrency(figures.adSpend, currency)}</Figure>
          <Sub>
            Ad spend only, excluding lead vendor costs
            <InfoTip label="Which spend this is" align="start">
              {`Spend on ${named}. Lead vendors and organic search have no ingested cost.`}
            </InfoTip>
          </Sub>
        </Cell>

        <Cell label={`Cost per ${deal} deal (all sources)`} unmeasured={costUnmeasured}>
          <CostPerDealFigure
            cost={figures.costPerDeal}
            currency={currency}
            channelLabel="ad"
            explanation={
              `${formatCurrency(figures.adSpend, currency)} of ad spend divided by all ` +
              `${formatCount(figures.deals)} ${deal} deals, from every source. Not any one channel's cost.`
            }
          />
        </Cell>

        <Cell label="Cost per acquisition (all sources)" unmeasured={costUnmeasured}>
          <CostPerDealFigure
            cost={figures.cpa}
            currency={currency}
            channelLabel="ad"
            noun={['approval', 'approvals']}
            explanation={
              `${formatCurrency(figures.adSpend, currency)} of ad spend divided by all ` +
              `${formatCount(figures.approvals)} approvals, from every source. Not any one channel's cost.`
            }
          />
        </Cell>
      </dl>
      {targets && targets.rows.length > 0 && (
        <>
          <div className="border-t border-border px-5 pt-4 pb-3">
            <h3 className="text-[14px] font-semibold text-text">Against the contract</h3>
            <p className="mt-0.5 text-[13px] text-text-2">
              {`${targets.heading}${targets.source ? ` · ${targets.source}` : ''}`}
            </p>
          </div>
          <dl className={SCORE_GRID}>
            {targets.rows.map((row) => (
              <ScoreCell
                key={row.metric}
                row={row}
                channel="all sources"
                currency={targets.currency}
                partial={targets.partial}
              />
            ))}
          </dl>
        </>
      )}
    </Card>
  );
}

function Cell({ label, unmeasured, children }: { label: string; unmeasured?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-surface px-5 py-4">
      <dt className="text-[13px] font-medium text-text-2">{label}</dt>
      <dd className="flex min-w-0 flex-col gap-1">
        {unmeasured ? (
          <span className="flex items-center gap-2 py-1.5">
            <Badge tone="warn" title={unmeasured}>
              Not measured
            </Badge>
            <span className="sr-only">{unmeasured}</span>
          </span>
        ) : (
          children
        )}
      </dd>
    </div>
  );
}

function Figure({ children }: { children: React.ReactNode }) {
  return <p className="text-[28px] font-semibold leading-[1.1] tabular text-text">{children}</p>;
}

function Sub({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-text-2">{children}</p>;
}

/** `Google Ads, Meta and LinkedIn`. */
function listed(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
