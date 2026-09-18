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
}: {
  data: MonthlyPerformance;
  counts: StageCounts;
  populationLabel: string;
}) {
  const { stages, stageStatus } = data;
  const reach: StageReach[] = stages.map((stage) => ({
    stage: stage.key,
    count: counts[stage.key] ?? 0,
    origin: stageStatus[stage.key]?.origin ?? 'observed',
  }));

  const measured = stages.map((s) => !stageStatus[s.key]?.blocked);

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
        const next = stages[i + 1];
        const bothMeasured = next ? measured[i] && measured[i + 1] : false;
        const adjacent = next && bothMeasured ? stageConversionRate(reach, stage.key, next.key) : null;
        const bridge = next && !bothMeasured ? bridgeFor(i) : null;
        const crossesGrain = next ? stage.source !== next.source : false;

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
                {stage.source === 'leads' ? 'inbound leads' : 'opportunities'}
                {stage.isOptimizationTarget && ' · target'}
              </p>
            </div>

            {next && (
              <div className="flex w-[46px] shrink-0 flex-col items-center justify-center gap-0.5 px-0.5">
                {adjacent ? (
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
