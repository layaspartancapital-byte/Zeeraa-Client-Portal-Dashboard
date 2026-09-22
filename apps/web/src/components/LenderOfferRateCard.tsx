import { formatCount, formatRate, type PopulationVerdict } from '@zeeraa/core';
import { KpiCard } from '@/components/KpiCard';
import { NoDelta } from '@/components/ui/Delta';
import type { MetricConfig } from '@/lib/dashboard';
import type { SubmissionReport } from '@/lib/reporting';

/**
 * The KPI that replaced Offer rate.
 *
 * Shared by the executive and performance screens so the figure and its
 * caveats cannot drift apart: the same word has to mean the same thing on
 * every screen, and this one has a caveat that travels with it.
 *
 * No delta. A comparison needs a comparable previous period, and the
 * submission object only begins in June 2026 — three months is not a baseline,
 * and an arrow drawn against a partial first month would be a statement about
 * when the object was switched on.
 */
export function LenderOfferRateCard({
  report,
  metric,
  gate,
  span,
}: {
  report: SubmissionReport;
  metric: MetricConfig | undefined;
  /**
   * Whether enough submissions have been decided for the rate to mean
   * anything.
   *
   * Optional, and absent means ungated. An offer rate over four decided
   * submissions can only take five values, and one of them is 25% — a figure
   * that looks like a finding and is an artefact of the denominator.
   */
  gate?: PopulationVerdict;
  span?: 3 | 4 | 6;
}) {
  const { overall } = report;
  const label = metric?.label ?? 'Lender offer rate';
  const withheld = gate !== undefined && !gate.sufficient;

  return (
    <KpiCard
      span={span}
      label={label}
      value={withheld || overall.rate === null ? null : formatRate(overall.rate)}
      notMeasured={
        withheld
          ? gate.reason!
          : report.empty
            ? 'No lender submissions are ingested yet'
            : 'No lender has decided a submission in this window'
      }
      delta={<NoDelta />}
      context={
        withheld || overall.rate === null
          ? undefined
          : `${formatCount(overall.offered)} of ${formatCount(overall.decided)} decided · ` +
            `${formatCount(overall.undecided)} awaiting an answer`
      }
      points={report.monthly.map((m) => ({
        label: m.label,
        // A month nobody decided in is blank, not zero.
        value: m.rate,
      }))}
      info={
        (metric?.definition ??
          "Submissions a lender offered on, over the submissions a lender has decided.") +
        ' This replaced a deal-level offer rate that measured whether somebody typed a date:' +
        ' approval and the first lender offer are the same event in this CRM.'
      }
    />
  );
}
