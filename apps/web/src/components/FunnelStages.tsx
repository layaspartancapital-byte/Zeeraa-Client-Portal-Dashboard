import { ArrowRight } from 'lucide-react';
import { formatCount, formatRate, stageConversionRate, type StageReach } from '@zeeraa/core';
import { NotMeasuredBadge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import type { MonthlyPerformance, StageCounts } from '@/lib/reporting';

/**
 * Horizontal stage cards with a conversion chip on each connector (spec v2 §6).
 *
 * Three things are deliberately not smoothed over:
 *
 *   - A stage nobody measures is a dimmed card the same size as the others with
 *     a `Not measured` badge, so the funnel stays visually continuous while
 *     saying plainly that it has a hole in it. Never a zero: a zero is a
 *     measurement, and nobody stamping that timestamp in the CRM is the
 *     opposite of one.
 *   - Where a blocked stage sits between two measured ones, the chip carries
 *     the transition that *can* be measured, labelled with what it spans. A gap
 *     in the instrumentation is not a gap in the funnel.
 *   - A rate that crosses a grain boundary — inbound leads into applications —
 *     says so, because comparing it to a rate inside one grain is a category
 *     error.
 *
 * Both halves of every rate come from the population the caller chose. This
 * component never mixes one.
 */
export function FunnelStages({
  data,
  counts,
  populationLabel,
  suppressed = [],
}: {
  data: MonthlyPerformance;
  counts: StageCounts;
  populationLabel: string;
  /**
   * Transitions that must carry no rate, each with the reason.
   *
   * Comes from a blocked metric whose formula is a stage conversion rate, so
   * one row retires a figure everywhere it appears rather than on the screen
   * somebody remembered.
   */
  suppressed?: { from: string; to: string; label: string; reason: string }[];
}) {
  const { stages, stageStatus, qualification } = data;
  // Which stage is the computed one, from configuration rather than the word.
  const mqlStageKey = stages.find((st) => st.key === 'mql')?.key ?? null;
  const reach: StageReach[] = stages.map((stage) => ({
    stage: stage.key,
    count: counts[stage.key] ?? 0,
    origin: stageStatus[stage.key]?.origin ?? 'observed',
  }));

  const measured = stages.map((s) => !stageStatus[s.key]?.blocked);

  /**
   * The grain of the record a stage is counted from.
   *
   * `qualified_leads` is a narrowing of `leads`, not a different kind of thing,
   * so a rate between them stays inside one grain and carries no caveat.
   */
  // `source` is optional in configuration and defaults to `stage_events`.
  const grainOf = (source: string | undefined) => (source === 'leads' || source === 'qualified_leads' ? 'lead' : 'opportunity');

  /**
   * Why a transition is not a conversion rate, or null when it is one.
   *
   * A conversion rate presumes the later population is drawn from the earlier
   * one. Two separate things can break that, and only one of them shows up in
   * the arithmetic:
   *
   *   * the ratio exceeds 100%, which is the arithmetic reporting that the
   *     denominator is the wrong population; and
   *   * the populations are declared not to nest, which stays invisible when
   *     the numerator happens to be the smaller number.
   *
   * The second is the case here. MQL is computed from self-reported fields
   * after the fact rather than being a gate a lead passes through, so an
   * unqualified lead can and does still apply: 441 applications against 649
   * qualified leads is 68% of a population the applications were never drawn
   * from. Before MQL was counted at lead grain the same transition read
   * 1,696% and the numeric guard caught it; at the right grain it looks
   * plausible, which is exactly why the rule cannot be left to arithmetic.
   */
  const notARate = (
    from: { key: string; source?: string },
    to: { key: string; source?: string },
    rate: { numerator: number; denominator: number },
  ): 'suppressed' | 'not-drawn-from' | 'over-total' | null => {
    if (suppressed.some((t) => t.from === from.key && t.to === to.key)) return 'suppressed';
    if (from.source === 'qualified_leads' && to.source !== 'qualified_leads') {
      return 'not-drawn-from';
    }
    if (rate.denominator !== 0 && rate.numerator > rate.denominator) return 'over-total';
    return null;
  };

  /**
   * For a gap that touches a blocked stage, the nearest measured stage on each
   * side — so the chip can carry the rate that survives the hole.
   */
  const bridgeFor = (gap: number) => {
    let from = gap;
    while (from >= 0 && !measured[from]) from -= 1;
    let to = gap + 1;
    while (to < stages.length && !measured[to]) to += 1;
    if (from < 0 || to >= stages.length) return null;
    // Only the first gap of a bridge carries it; the rest are plain connectors.
    if (gap !== from) return null;
    return {
      from: stages[from]!,
      to: stages[to]!,
      skipped: stages.slice(from + 1, to).map((s) => s.label),
      rate: stageConversionRate(reach, stages[from]!.key, stages[to]!.key),
    };
  };

  return (
    <div className="flex flex-wrap items-stretch gap-y-3 px-5 pb-5">
      {stages.map((stage, i) => {
        const blocked = stageStatus[stage.key]?.blocked;
        const coverage = stageStatus[stage.key]?.coverage ?? null;
        const next = stages[i + 1];
        const bothMeasured = next ? measured[i] && measured[i + 1] : false;
        const adjacent = next && bothMeasured ? stageConversionRate(reach, stage.key, next.key) : null;
        const bridge = next && !bothMeasured ? bridgeFor(i) : null;
        const crossesGrain = next ? grainOf(stage.source) !== grainOf(next.source) : false;
        const noRateBecause = next && adjacent ? notARate(stage, next, adjacent) : null;

        return (
          <div key={stage.key} className="flex min-w-0 flex-1 basis-[132px] items-stretch">
            <div
              className={`min-w-0 flex-1 rounded-[8px] border px-3 pb-3 pt-2.5 ${
                blocked
                  ? 'border-dashed border-border bg-canvas'
                  : 'border-border bg-surface'
              } ${stage.isOptimizationTarget && !blocked ? 'border-t-[3px] border-t-primary' : ''}`}
            >
              <p
                className={`flex items-center gap-1 text-[12px] font-medium ${
                  blocked ? 'text-text-3' : 'text-text-2'
                }`}
              >
                <span className="leading-tight">{stage.label}</span>
                {blocked && (
                  <InfoTip label={`Why ${stage.label} is not measured`} align="start">
                    {blocked.reason}
                    {blocked.needed ? ` Needed: ${blocked.needed}` : ''}
                  </InfoTip>
                )}
              </p>

              {blocked ? (
                <p className="mt-2">
                  <NotMeasuredBadge />
                </p>
              ) : (
                <p className="mt-1 text-[24px] font-semibold leading-tight tabular text-text">
                  {formatCount(counts[stage.key] ?? 0)}
                </p>
              )}

              <p className="mt-1 text-[12px] leading-tight text-text-3">
                {stage.source === 'leads'
                  ? 'inbound leads'
                  : stage.source === 'qualified_leads'
                    ? 'leads past the bar'
                    : 'opportunities'}
                {stage.isOptimizationTarget && ' · target'}
              </p>

              {/*
                A computed stage never renders as a bare count.
                MQL is the bar evaluated against bands, and a band containing
                the threshold resolves to neither answer — so the count is only
                as meaningful as the share of the population the bar could be
                run against. The two are separate facts, not one ratio: the
                count is opportunity grain and the coverage is lead grain.
              */}
              {!blocked && stage.key === mqlStageKey && qualification.coverage !== null && (
                <p className="mt-1 flex items-center gap-1 text-[12px] leading-tight text-text-3">
                  <span className="tabular">
                    {formatRate(qualification.coverage)} of leads assessable
                  </span>
                  <InfoTip label="What MQL coverage means" align="start">
                    The bar could be evaluated against{' '}
                    {formatCount(qualification.qualified + qualification.unqualified)} of{' '}
                    {formatCount(qualification.total)} leads in this window.{' '}
                    {formatCount(qualification.undeterminable)} answer in a band that spans the
                    threshold, or in a field nobody can decode, and are neither qualified nor
                    unqualified.
                    {qualification.topReason ? ` Most commonly: ${qualification.topReason}.` : ''}
                    {qualification.unevaluated > 0
                      ? ` A further ${formatCount(qualification.unevaluated)} have not been assessed yet and are counted in neither.`
                      : ''}
                  </InfoTip>
                </p>
              )}

              {/*
                A horizon on the source, shown on the figure rather than in a
                footnote. This stage is read from field history, which begins
                when tracking was switched on — so the count is complete inside
                that window and silent before it, and a reader comparing it to
                an older period needs to know that here.
              */}
              {!blocked && coverage && (
                <p className="mt-1 flex items-center gap-1 text-[12px] leading-tight text-text-3">
                  <span className="tabular">
                    from {coverage.from.toISOString().slice(0, 10)}
                  </span>
                  <InfoTip label={`What limits ${stage.label} coverage`} align="start">
                    Read from {coverage.source}, which starts on{' '}
                    {coverage.from.toISOString().slice(0, 10)} — the day tracking was switched on.
                    Transitions inside that window are recorded facts; anything earlier cannot be
                    read at all, so a period beginning before it is understated rather than low.
                  </InfoTip>
                </p>
              )}
            </div>

            {next && (
              <div className="flex w-[46px] shrink-0 flex-col items-center justify-center gap-0.5 px-0.5">
                {adjacent && noRateBecause ? (
                  <>
                    <span className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-border bg-canvas px-1.5 py-[2px] text-[12px] font-semibold text-text-3">
                      —
                    </span>
                    <InfoTip label="Why there is no rate here" align="center">
                      {noRateBecause === 'suppressed' ? (
                        suppressed.find((t) => t.from === stage.key && t.to === next.key)?.reason
                      ) : (
                        <>
                      {formatCount(adjacent.numerator)} reached {next.label} against{' '}
                      {formatCount(adjacent.denominator)} at {stage.label}.{' '}
                      {noRateBecause === 'not-drawn-from'
                        ? `${stage.label} is computed from what a lead reported, not a gate it
                           passes through — a lead that misses the bar can still reach
                           ${next.label}. So ${next.label} is not drawn from ${stage.label}, and
                           the ratio is not a conversion rate even though it lands under 100%.`
                        : `These are not nested populations, so their ratio is not a conversion
                           rate — the stages count different things rather than the same deals at
                           two moments.`}
                        </>
                      )}
                    </InfoTip>
                  </>
                ) : adjacent ? (
                  <>
                    <span className="inline-flex items-center gap-0.5 rounded-full border border-border bg-surface px-1.5 py-[2px] text-[12px] font-semibold tabular text-text">
                      <ArrowRight aria-hidden="true" className="h-3 w-3 text-text-3" />
                      {adjacent.rate === null ? '—' : formatRate(adjacent.rate)}
                    </span>
                    {crossesGrain && (
                      <InfoTip label="This rate crosses a grain boundary" align="center">
                        This rate divides opportunities by inbound leads. It is a different kind of
                        statement from a rate inside one grain, and the two are not comparable.
                      </InfoTip>
                    )}
                  </>
                ) : bridge ? (
                  <>
                    <span className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-warn bg-warn-soft px-1.5 py-[2px] text-[12px] font-semibold tabular text-[#B54708]">
                      <ArrowRight aria-hidden="true" className="h-3 w-3" />
                      {bridge.rate.rate === null ? '—' : formatRate(bridge.rate.rate)}
                    </span>
                    <InfoTip label="What this rate spans" align="center">
                      {bridge.from.label} to {bridge.to.label}, {formatCount(bridge.rate.numerator)}{' '}
                      of {formatCount(bridge.rate.denominator)} — measured across{' '}
                      {bridge.skipped.join(', ')}, which{' '}
                      {bridge.skipped.length === 1 ? 'is' : 'are'} not measured.
                    </InfoTip>
                  </>
                ) : (
                  <span
                    aria-hidden="true"
                    className="h-px w-5 bg-border"
                    title="Not measurable across this gap"
                  />
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* `sr-only` on a wrapper, not on the table: see `ChartTable`. */}
      <div className="sr-only">
        <table>
          <caption>Stage counts and conversion rates for {populationLabel}.</caption>
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Count</th>
              <th scope="col">Conversion from previous stage</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((stage, i) => {
              const blocked = stageStatus[stage.key]?.blocked;
              const previous = stages[i - 1];
              const rate =
                previous && measured[i] && measured[i - 1]
                  ? stageConversionRate(reach, previous.key, stage.key)
                  : null;
              return (
                <tr key={stage.key}>
                  <td>{stage.label}</td>
                  <td>{blocked ? 'not measured' : formatCount(counts[stage.key] ?? 0)}</td>
                  <td>{rate?.rate === null || !rate ? 'not measurable' : formatRate(rate.rate)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
