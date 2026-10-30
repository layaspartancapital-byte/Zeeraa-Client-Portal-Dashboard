import { formatCount, formatCurrency } from '@zeeraa/core';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { CostPerDealFigure } from '@/components/CostPerDeal';
import { platformLabel } from '@/lib/platform-labels';
import type { AllSources } from '@/lib/all-sources';

/**
 * Every source at once, beside the one channel the contract names: the
 * period's deals from everywhere, every ad platform's spend, and the blended
 * costs between them.
 *
 * Laid out as `RampScorecard` is, and with no target line: the targets are
 * contracted for Google Ads alone, and a blended figure has none. "Blended" is
 * in the title and in every cost's label, because a reader who takes it for a
 * channel's cost per deal will credit the ads with the sales team's month.
 */
export function AllSourcesCard({
  figures,
  valueLabel,
  periodLabel,
  currency,
  crmUnmeasured,
  spendUnmeasured,
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
}) {
  const deal = valueLabel.toLowerCase();
  const platforms = figures.spendPlatforms.map(platformLabel);
  const named = platforms.length === 0 ? 'the ad platforms' : listed(platforms);
  const costUnmeasured = crmUnmeasured ?? spendUnmeasured;

  return (
    <Card span={12} id="all-sources">
      <CardHeader title="All sources · blended" subtitle={periodLabel} />
      <dl className="grid grid-cols-1 gap-px border-t border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
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

        <Cell label={`Blended cost per ${deal} deal`} unmeasured={costUnmeasured}>
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

        <Cell label="Blended CPA" unmeasured={costUnmeasured}>
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
